package nginx

import (
	"bufio"
	"crypto/sha1"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// These backends only test proxy transport; they do not emulate model inference or Jupyter authentication.
func TestTemplatesThroughRealNginx(t *testing.T) {
	cert, err := os.ReadFile("/qa/cert.pem")
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(cert) {
		t.Fatal("invalid fixture certificate")
	}
	client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	trustedNode := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}, DialContext: (&net.Dialer{LocalAddr: &net.TCPAddr{IP: net.ParseIP("127.0.0.3")}}).DialContext}}
	t.Cleanup(client.CloseIdleConnections)
	t.Cleanup(trustedNode.CloseIdleConnections)
	var failures atomic.Int32
	apiRelease, nodeRelease := make(chan struct{}), make(chan struct{})
	backend := func(release chan struct{}) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.URL.Path == "/v1/stream":
				w.Header().Set("Content-Type", "text/event-stream")
				io.WriteString(w, "data: first\n\n")
				w.(http.Flusher).Flush()
				select {
				case <-release:
					io.WriteString(w, "data: [DONE]\n\n")
				case <-r.Context().Done():
				}
			case strings.HasSuffix(r.URL.Path, "/fail"):
				failures.Add(1)
				conn, _, e := w.(http.Hijacker).Hijack()
				if e == nil {
					conn.Close()
				}
			case strings.HasSuffix(r.URL.Path, "/channels"):
				if r.Header.Get("Upgrade") != "websocket" || !strings.EqualFold(r.Header.Get("Connection"), "upgrade") {
					http.Error(w, "upgrade missing", 400)
					return
				}
				key, e := base64.StdEncoding.DecodeString(r.Header.Get("Sec-WebSocket-Key"))
				if e != nil || len(key) != 16 || r.Header.Get("Sec-WebSocket-Version") != "13" {
					http.Error(w, "invalid fixture handshake", 400)
					return
				}
				conn, rw, e := w.(http.Hijacker).Hijack()
				if e != nil {
					t.Error(e)
					return
				}
				defer conn.Close()
				conn.SetDeadline(time.Now().Add(5 * time.Second))
				sum := sha1.Sum([]byte(r.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
				rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + base64.StdEncoding.EncodeToString(sum[:]) + "\r\n\r\n")
				rw.Flush()
				frame := make([]byte, 10)
				if _, e = io.ReadFull(rw, frame); e != nil {
					t.Error(e)
					return
				}
				if frame[0] != 0x81 || frame[1] != 0x84 {
					t.Error("invalid fixture client frame")
					return
				}
				for i := 0; i < 4; i++ {
					frame[6+i] ^= frame[2+i]
				}
				if string(frame[6:]) != "ping" {
					t.Error("client payload changed")
					return
				}
				conn.Write(append([]byte{0x81, 4}, []byte("pong")...))
			default:
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("X-Request-ID", "fixture-request-id")
				http.SetCookie(w, &http.Cookie{Name: "lab", Value: "fixture", Path: "/"})
				http.SetCookie(w, &http.Cookie{Name: "_xsrf", Value: "fixture", Path: "/"})
				json.NewEncoder(w).Encode(map[string]string{"uri": r.URL.RequestURI(), "xff": r.Header.Get("X-Forwarded-For"), "proto": r.Header.Get("X-Forwarded-Proto"), "forwarded": r.Header.Get("Forwarded"), "real": r.Header.Get("X-Real-IP"), "cookie": r.Header.Get("Cookie"), "authorization": r.Header.Get("Authorization")})
			}
		})
	}
	for address, handler := range map[string]http.Handler{"127.0.0.1:3001": backend(apiRelease), "127.0.0.1:8000": backend(nodeRelease)} {
		listener, e := net.Listen("tcp", address)
		if e != nil {
			t.Fatal(e)
		}
		server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second}
		go server.Serve(listener)
		t.Cleanup(func() { server.Close() })
	}
	command := exec.Command("nginx", "-c", "/qa/runtime.conf", "-g", "daemon off;")
	command.Stdout = os.Stderr
	command.Stderr = os.Stderr
	if err = command.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan error, 1)
	go func() { exited <- command.Wait() }()
	stopped := false
	t.Cleanup(func() {
		if !stopped {
			command.Process.Kill()
			select {
			case <-exited:
			case <-time.After(5 * time.Second):
				t.Error("nginx did not exit")
			}
		}
	})
	deadline := time.Now().Add(5 * time.Second)
	for {
		r, e := client.Get("https://127.0.0.1/api/probe")
		if e == nil {
			r.Body.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("nginx did not become ready", e)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if _, e := http.Get("https://127.0.0.1/api/probe"); e == nil {
		t.Fatal("untrusted fixture certificate accepted")
	} else {
		var unknown x509.UnknownAuthorityError
		if !errors.As(e, &unknown) {
			t.Fatal("expected certificate verification failure", e)
		}
	}
	check := func(c *http.Client, url string, headers map[string]string, want int) map[string]string {
		t.Helper()
		request, e := http.NewRequest("GET", url, nil)
		if e != nil {
			t.Fatal(e)
		}
		for key, value := range headers {
			request.Header.Set(key, value)
		}
		response, e := c.Do(request)
		if e != nil {
			t.Fatal(e)
		}
		defer response.Body.Close()
		if response.StatusCode != want {
			t.Fatalf("unexpected proxy status %d, want %d", response.StatusCode, want)
		}
		if want != 200 {
			return nil
		}
		var body map[string]string
		if e = json.NewDecoder(response.Body).Decode(&body); e != nil {
			t.Fatal(e)
		}
		return body
	}
	spoof := map[string]string{"X-Forwarded-For": "198.51.100.99", "X-Forwarded-Proto": "http", "Forwarded": "for=198.51.100.99;proto=http", "X-Real-IP": "198.51.100.99", "Cookie": "fixture=transport"}
	echo := check(client, "https://127.0.0.1/api/echo?token=QA_SECRET_MARKER", spoof, 200)
	if echo["xff"] != "127.0.0.1" || echo["proto"] != "https" || echo["forwarded"] != "" || echo["real"] != "" || echo["cookie"] != "fixture=transport" {
		t.Fatal("console forwarding policy failed", echo)
	}
	redirect, _ := http.NewRequest("GET", "http://127.0.0.1/path?token=QA_SECRET_MARKER", nil)
	redirect.Host = "attacker.invalid"
	response, e := client.Do(redirect)
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	if response.StatusCode != 308 || response.Header.Get("Location") != "https://console.example.invalid/path?token=QA_SECRET_MARKER" {
		t.Fatal("canonical redirect failed")
	}
	static, e := client.Get("https://127.0.0.1/frontend/route")
	if e != nil {
		t.Fatal(e)
	}
	text, _ := io.ReadAll(static.Body)
	static.Body.Close()
	if static.StatusCode != 200 || !strings.Contains(string(text), "Isolated CoreMatrix") {
		t.Fatal("SPA fallback failed")
	}
	check(client, "https://127.0.0.2:8000/v1/models", map[string]string{"X-Forwarded-For": "127.0.0.3"}, 403)
	if check(trustedNode, "https://127.0.0.2:8000/v1/models", map[string]string{"Authorization": "Bearer fixture-key"}, 200)["authorization"] != "Bearer fixture-key" {
		t.Fatal("inference authorization changed")
	}
	check(client, "https://127.0.0.2:8000/unexposed", nil, 404)
	workspace := "https://127.0.0.2:8000/api/compute/rentals/qa/"
	echo = check(client, workspace+"api?token=QA_SECRET_MARKER", spoof, 200)
	if echo["uri"] != "/api/compute/rentals/qa/api?token=QA_SECRET_MARKER" || echo["proto"] != "https" || echo["xff"] != "127.0.0.1" || echo["forwarded"] != "" || echo["real"] != "" {
		t.Fatal("workspace forwarding policy failed", echo)
	}
	response, e = client.Get(workspace)
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	if len(response.Cookies()) != 2 {
		t.Fatal("workspace cookies missing")
	}
	for _, cookie := range response.Cookies() {
		if !cookie.Secure || cookie.HttpOnly {
			t.Fatal("workspace cookie flags changed", cookie.Name)
		}
	}
	for _, stream := range []struct {
		client  *http.Client
		url     string
		release chan struct{}
	}{{client, "https://127.0.0.1/v1/stream", apiRelease}, {trustedNode, "https://127.0.0.2:8000/v1/stream", nodeRelease}} {
		response, e = stream.client.Get(stream.url)
		if e != nil {
			t.Fatal(e)
		}
		if response.StatusCode != 200 || response.Header.Get("Content-Type") != "text/event-stream" {
			t.Fatal("stream headers changed")
		}
		reader := bufio.NewReader(response.Body)
		first, e := reader.ReadString('\n')
		if e != nil || first != "data: first\n" {
			t.Fatal("SSE first chunk buffered or changed", e)
		}
		close(stream.release)
		tail, e := io.ReadAll(reader)
		response.Body.Close()
		if e != nil || !strings.Contains(string(tail), "data: [DONE]") {
			t.Fatal("SSE completion missing", e)
		}
	}
	connection, e := tls.DialWithDialer(&net.Dialer{Timeout: 5 * time.Second}, "tcp", "127.0.0.2:8000", &tls.Config{RootCAs: pool, ServerName: "127.0.0.2"})
	if e != nil {
		t.Fatal(e)
	}
	connection.SetDeadline(time.Now().Add(5 * time.Second))
	io.WriteString(connection, "GET /api/compute/rentals/qa/channels?token=QA_SECRET_MARKER HTTP/1.1\r\nHost: 127.0.0.2:8000\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n")
	reader := bufio.NewReader(connection)
	upgraded, e := http.ReadResponse(reader, nil)
	if e != nil {
		t.Fatal(e)
	}
	if upgraded.StatusCode != 101 || upgraded.Header.Get("Sec-WebSocket-Accept") != "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" {
		t.Fatal("websocket handshake changed")
	}
	connection.Write([]byte{0x81, 0x84, 1, 2, 3, 4, 'p' ^ 1, 'i' ^ 2, 'n' ^ 3, 'g' ^ 4})
	frame := make([]byte, 6)
	_, e = io.ReadFull(reader, frame)
	connection.Close()
	if e != nil || frame[0] != 0x81 || frame[1] != 4 || string(frame[2:]) != "pong" {
		t.Fatal("websocket bidirectional payload failed", e)
	}
	check(client, "https://127.0.0.1/api/fail?token=QA_SECRET_MARKER", nil, 502)
	check(client, workspace+"fail?token=QA_SECRET_MARKER", nil, 502)
	if failures.Load() != 2 {
		t.Fatal("failed upstream was retried")
	}
	for _, address := range []string{"127.0.0.1:80", "127.0.0.1:443", "127.0.0.2:8000"} {
		var connection net.Conn
		if strings.HasSuffix(address, ":80") {
			connection, e = net.DialTimeout("tcp", address, 5*time.Second)
		} else {
			connection, e = tls.DialWithDialer(&net.Dialer{Timeout: 5 * time.Second}, "tcp", address, &tls.Config{RootCAs: pool, ServerName: strings.Split(address, ":")[0]})
		}
		if e != nil {
			t.Fatal(e)
		}
		connection.SetDeadline(time.Now().Add(5 * time.Second))
		io.WriteString(connection, "GET /api/compute/rentals/qa/?token=QA_SECRET_MARKER HTTP/1.1\r\nHost: "+address+"\r\nContent-Length: invalid\r\n\r\n")
		malformed, e := http.ReadResponse(bufio.NewReader(connection), nil)
		if e != nil {
			connection.Close()
			t.Fatal(e)
		}
		io.Copy(io.Discard, malformed.Body)
		malformed.Body.Close()
		connection.Close()
		if malformed.StatusCode != 400 {
			t.Fatal("malformed request not rejected")
		}
	}
	client.CloseIdleConnections()
	trustedNode.CloseIdleConnections()
	command.Process.Signal(syscall.SIGQUIT)
	select {
	case e = <-exited:
		stopped = true
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("nginx did not drain")
	}
	for _, path := range []string{"/var/log/nginx/corematrix-access.log", "/var/log/nginx/corematrix-lab-access.log", "/tmp/master-error.log"} {
		data, e := os.ReadFile(path)
		if e != nil {
			t.Fatal(e)
		}
		if strings.HasSuffix(path, "corematrix-access.log") && (!strings.Contains(string(data), "GET 200 ") || !strings.Contains(string(data), "fixture-request-id") || !strings.Contains(string(data), "GET 502 ") || !strings.Contains(string(data), "GET 400 ")) {
			t.Fatal("console safe access records missing")
		}
		if strings.HasSuffix(path, "corematrix-lab-access.log") && (!strings.Contains(string(data), "101 ") || !strings.Contains(string(data), "502 ") || !strings.Contains(string(data), "400 ")) {
			t.Fatal("workspace safe access records missing")
		}
		if strings.Contains(string(data), "QA_SECRET_MARKER") || strings.Contains(string(data), "fixture-key") || strings.Contains(string(data), "fixture=transport") {
			t.Fatal("proxy log leaked fixture credential", path)
		}
	}
}
