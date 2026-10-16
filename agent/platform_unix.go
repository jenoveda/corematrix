//go:build linux || darwin

package main

import (
	"os"
	"path/filepath"
	"syscall"
)

func lockNode(stateDir string) (*os.File, error) {
	f, err := os.OpenFile(filepath.Join(stateDir, "agent.lock"), os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return nil, diagnostic("agent_lock_unavailable")
	}
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, diagnostic("agent_already_running")
	}
	return f, nil
}
func freeDisk(path string) (uint64, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, diagnostic("disk_inventory_failed")
	}
	return uint64(stat.Bavail) * uint64(stat.Bsize), nil
}
