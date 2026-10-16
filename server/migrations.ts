import type { DatabaseSync } from "node:sqlite";
export const LATEST_SCHEMA_VERSION = 11;
export function migrate(db: DatabaseSync) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,appliedAt TEXT NOT NULL)",
  );
  if (
    !db.prepare("SELECT version FROM schema_migrations WHERE version=1").get()
  ) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(
        "ALTER TABLE users ADD COLUMN locale TEXT NOT NULL DEFAULT 'zh-CN';ALTER TABLE ledger ADD COLUMN metadata TEXT;",
      );
      db.prepare("INSERT INTO schema_migrations VALUES(1,?)").run(
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  if (
    !db.prepare("SELECT version FROM schema_migrations WHERE version=2").get()
  ) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
    CREATE TABLE servers(id TEXT PRIMARY KEY,data TEXT NOT NULL,tokenHash TEXT NOT NULL UNIQUE,deleted INTEGER NOT NULL DEFAULT 0,instanceId TEXT,bootId TEXT,generation INTEGER NOT NULL DEFAULT 0,sequence INTEGER NOT NULL DEFAULT -1,lastHeartbeat INTEGER,inventoryError TEXT,capabilities TEXT NOT NULL DEFAULT '{}',containers TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE gpus(serverId TEXT NOT NULL REFERENCES servers(id),uuid TEXT NOT NULL,data TEXT NOT NULL,missing INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(serverId,uuid));
    CREATE TABLE deployments(id TEXT PRIMARY KEY,serverId TEXT NOT NULL REFERENCES servers(id),modelId TEXT NOT NULL REFERENCES models(id),phase TEXT NOT NULL,desiredState TEXT NOT NULL DEFAULT 'running',spec TEXT NOT NULL,replaces TEXT REFERENCES deployments(id),actorId TEXT NOT NULL REFERENCES users(id),requestKey TEXT NOT NULL,fingerprint TEXT NOT NULL,createdAt INTEGER NOT NULL,healthAt INTEGER,lastError TEXT,UNIQUE(actorId,requestKey));
    CREATE UNIQUE INDEX deployment_replacement ON deployments(replaces) WHERE phase!='stopped';
    CREATE TABLE gpu_allocations(deploymentId TEXT NOT NULL REFERENCES deployments(id),serverId TEXT NOT NULL,uuid TEXT NOT NULL,released INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(deploymentId,uuid));
    CREATE UNIQUE INDEX active_gpu ON gpu_allocations(serverId,uuid) WHERE released=0;
    CREATE TABLE port_allocations(deploymentId TEXT PRIMARY KEY REFERENCES deployments(id),serverId TEXT NOT NULL,port INTEGER NOT NULL,released INTEGER NOT NULL DEFAULT 0);
    CREATE UNIQUE INDEX active_port ON port_allocations(serverId,port) WHERE released=0;
    CREATE TABLE deployment_jobs(id TEXT PRIMARY KEY,deploymentId TEXT NOT NULL REFERENCES deployments(id),kind TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',attempt INTEGER NOT NULL DEFAULT 0,generation INTEGER,leaseHash TEXT,leaseExpires INTEGER,claimedAt INTEGER,createdAt INTEGER NOT NULL);
    CREATE TABLE deployment_events(id INTEGER PRIMARY KEY AUTOINCREMENT,deploymentId TEXT NOT NULL REFERENCES deployments(id),jobId TEXT,attempt INTEGER,eventId TEXT,event TEXT NOT NULL,message TEXT NOT NULL,time INTEGER NOT NULL,fingerprint TEXT,UNIQUE(jobId,attempt,eventId));
    ALTER TABLE requests ADD COLUMN deploymentId TEXT REFERENCES deployments(id);
   `);
      db.prepare("INSERT INTO schema_migrations VALUES(2,?)").run(
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  if (
    !db.prepare("SELECT version FROM schema_migrations WHERE version=3").get()
  ) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(
        "ALTER TABLE deployments ADD COLUMN workloadType TEXT NOT NULL DEFAULT 'inference';ALTER TABLE deployments ADD COLUMN ownerId TEXT REFERENCES users(id);",
      );
      db.prepare(
        "INSERT OR IGNORE INTO models(id,data,deleted) VALUES('__gpu-rental__','{}',1)",
      ).run();
      db.prepare("INSERT INTO schema_migrations VALUES(3,?)").run(
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  if (
    !db.prepare("SELECT version FROM schema_migrations WHERE version=4").get()
  ) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
    CREATE TABLE rental_orders(id TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES users(id),deploymentId TEXT NOT NULL UNIQUE REFERENCES deployments(id),offerId TEXT NOT NULL,resource TEXT NOT NULL,cards INTEGER NOT NULL,hours INTEGER NOT NULL,hourlyPrice INTEGER NOT NULL,amount INTEGER NOT NULL,reserved INTEGER NOT NULL,status TEXT NOT NULL,charged INTEGER NOT NULL DEFAULT 0,refunded INTEGER NOT NULL DEFAULT 0,createdAt INTEGER NOT NULL,startedAt INTEGER,expiresAt INTEGER,stopRequestedAt INTEGER,closedAt INTEGER,expiryAcknowledgedAt INTEGER,requestKey TEXT NOT NULL,fingerprint TEXT NOT NULL,UNIQUE(userId,requestKey));
    CREATE INDEX rental_orders_due ON rental_orders(status,expiresAt);
    ALTER TABLE ledger RENAME TO ledger_v3;
    CREATE TABLE ledger(id TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES users(id),type TEXT NOT NULL CHECK(type IN ('token','recharge','compute','compute_refund')),resource TEXT NOT NULL,quantity TEXT NOT NULL,amount INTEGER NOT NULL,inputPrice INTEGER,outputPrice INTEGER,time TEXT NOT NULL,day TEXT NOT NULL,requestId TEXT UNIQUE REFERENCES requests(id),reference TEXT UNIQUE,actorId TEXT REFERENCES users(id),metadata TEXT);
    INSERT INTO ledger(rowid,id,userId,type,resource,quantity,amount,inputPrice,outputPrice,time,day,requestId,reference,actorId,metadata) SELECT rowid,id,userId,type,resource,quantity,amount,inputPrice,outputPrice,time,day,requestId,reference,actorId,metadata FROM ledger_v3;
    DROP TABLE ledger_v3;
    CREATE INDEX ledger_user_time ON ledger(userId,time);
   `);
      db.prepare("INSERT INTO schema_migrations VALUES(4,?)").run(
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  if (
    !db.prepare("SELECT version FROM schema_migrations WHERE version=5").get()
  ) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        ALTER TABLE rental_orders ADD COLUMN expiryRevision INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE rental_orders ADD COLUMN confirmedExpiresAt INTEGER;
        UPDATE rental_orders SET confirmedExpiresAt=expiresAt WHERE expiryAcknowledgedAt IS NOT NULL;
        CREATE TABLE rental_actions(id TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES users(id),orderId TEXT NOT NULL REFERENCES rental_orders(id),requestKey TEXT NOT NULL,fingerprint TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('renew','cancel')),hours INTEGER NOT NULL,amount INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed')),revision INTEGER NOT NULL,expiresAt INTEGER,createdAt INTEGER NOT NULL,UNIQUE(userId,requestKey));
        CREATE UNIQUE INDEX rental_pending_renewal ON rental_actions(orderId) WHERE kind='renew' AND status='pending';
      `);
      db.prepare("INSERT INTO schema_migrations VALUES(5,?)").run(
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  if (
    !db.prepare("SELECT version FROM schema_migrations WHERE version=6").get()
  ) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(
        `CREATE TABLE expenses(id TEXT PRIMARY KEY,category TEXT NOT NULL,amount INTEGER NOT NULL CHECK(amount BETWEEN 1 AND 100000000000000),day TEXT NOT NULL,reason TEXT NOT NULL,reference TEXT NOT NULL UNIQUE,serverId TEXT REFERENCES servers(id),serverName TEXT,actorId TEXT NOT NULL REFERENCES users(id),createdAt TEXT NOT NULL,voidedAt TEXT,voidReason TEXT,voidActorId TEXT REFERENCES users(id));CREATE INDEX expenses_day ON expenses(day);`,
      );
      db.prepare("INSERT INTO schema_migrations VALUES(6,?)").run(
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  if (
    !db.prepare("SELECT version FROM schema_migrations WHERE version=7").get()
  ) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`ALTER TABLE users ADD COLUMN emailVerifiedAt TEXT;
        CREATE TABLE account_tokens(tokenHash TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES users(id),purpose TEXT NOT NULL CHECK(purpose IN ('verify','reset')),expires INTEGER NOT NULL,createdAt INTEGER NOT NULL,UNIQUE(userId,purpose));`);
      db.prepare("INSERT INTO schema_migrations VALUES(7,?)").run(
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  if (
    !db.prepare("SELECT version FROM schema_migrations WHERE version=8").get()
  ) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        ALTER TABLE users ADD COLUMN paymentDebt INTEGER NOT NULL DEFAULT 0 CHECK(paymentDebt BETWEEN 0 AND 9007199254740991);
        CREATE INDEX users_payment_debt ON users(paymentDebt) WHERE paymentDebt>0;
        CREATE TABLE payment_orders(id TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES users(id),requestKey TEXT NOT NULL,fingerprint TEXT NOT NULL,amount INTEGER NOT NULL,currency TEXT NOT NULL DEFAULT 'cny',locale TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'creating',sessionId TEXT UNIQUE,paymentIntentId TEXT UNIQUE,chargeId TEXT UNIQUE,checkoutUrl TEXT,credited INTEGER NOT NULL DEFAULT 0,refunded INTEGER NOT NULL DEFAULT 0,lostAmount INTEGER NOT NULL DEFAULT 0,reversed INTEGER NOT NULL DEFAULT 0,review INTEGER NOT NULL DEFAULT 0,disputeId TEXT,disputeStatus TEXT,reviewAt INTEGER NOT NULL DEFAULT 0,createdAt INTEGER NOT NULL,expiresAt INTEGER NOT NULL,checkedAt INTEGER,UNIQUE(userId,requestKey));
        CREATE INDEX payment_orders_user ON payment_orders(userId,createdAt);
        CREATE TABLE payment_refunds(id TEXT PRIMARY KEY,orderId TEXT NOT NULL REFERENCES payment_orders(id),amount INTEGER NOT NULL,status TEXT NOT NULL);CREATE INDEX payment_refunds_order ON payment_refunds(orderId);
        CREATE TABLE payment_events(id TEXT PRIMARY KEY,type TEXT NOT NULL,fingerprint TEXT NOT NULL,orderId TEXT REFERENCES payment_orders(id),receivedAt INTEGER NOT NULL);
        ALTER TABLE ledger RENAME TO ledger_v7;
        CREATE TABLE ledger(id TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES users(id),type TEXT NOT NULL CHECK(type IN ('token','recharge','compute','compute_refund','recharge_refund')),resource TEXT NOT NULL,quantity TEXT NOT NULL,amount INTEGER NOT NULL,inputPrice INTEGER,outputPrice INTEGER,time TEXT NOT NULL,day TEXT NOT NULL,requestId TEXT UNIQUE REFERENCES requests(id),reference TEXT UNIQUE,actorId TEXT REFERENCES users(id),metadata TEXT);
        INSERT INTO ledger(rowid,id,userId,type,resource,quantity,amount,inputPrice,outputPrice,time,day,requestId,reference,actorId,metadata) SELECT rowid,id,userId,type,resource,quantity,amount,inputPrice,outputPrice,time,day,requestId,reference,actorId,metadata FROM ledger_v7;
        DROP TABLE ledger_v7;
        CREATE INDEX ledger_user_time ON ledger(userId,time);
      `);
      db.prepare("INSERT INTO schema_migrations VALUES(8,?)").run(
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  if (
    !db.prepare("SELECT version FROM schema_migrations WHERE version=9").get()
  ) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`CREATE TABLE rental_reservations(id TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES users(id),serverId TEXT NOT NULL REFERENCES servers(id),serverName TEXT NOT NULL,offerId TEXT NOT NULL,resource TEXT NOT NULL,memoryMiB INTEGER NOT NULL,cards INTEGER NOT NULL,hours INTEGER NOT NULL,hourlyPrice INTEGER NOT NULL,amount INTEGER NOT NULL,reserved INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('booked','starting','active','stopping','completed','canceled','failed')),gpuUuids TEXT NOT NULL,port INTEGER NOT NULL,startsAt INTEGER NOT NULL,endsAt INTEGER NOT NULL,createdAt INTEGER NOT NULL,closedAt INTEGER,errorCode TEXT,cancelActorId TEXT REFERENCES users(id),cancelReason TEXT,requestKey TEXT NOT NULL,fingerprint TEXT NOT NULL,orderId TEXT UNIQUE REFERENCES rental_orders(id),UNIQUE(userId,requestKey));
        CREATE INDEX reservations_window ON rental_reservations(serverId,startsAt,endsAt) WHERE status IN ('booked','starting','active','stopping');
        ALTER TABLE rental_orders ADD COLUMN reservationId TEXT REFERENCES rental_reservations(id);
        CREATE UNIQUE INDEX rental_reservation_order ON rental_orders(reservationId) WHERE reservationId IS NOT NULL;
        ALTER TABLE rental_orders ADD COLUMN scheduledStart INTEGER;
        ALTER TABLE rental_orders ADD COLUMN scheduledEnd INTEGER;`);
      db.prepare("INSERT INTO schema_migrations VALUES(9,?)").run(
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  if (
    !db.prepare("SELECT version FROM schema_migrations WHERE version=10").get()
  ) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`CREATE TABLE ops_alerts(id TEXT PRIMARY KEY,code TEXT NOT NULL,entityId TEXT NOT NULL,severity TEXT NOT NULL CHECK(severity IN ('warning','critical')),details TEXT NOT NULL,detectedAt INTEGER NOT NULL,openedAt INTEGER,lastSeenAt INTEGER NOT NULL,ackAt INTEGER,ackActorId TEXT REFERENCES users(id),resolvedAt INTEGER);
        CREATE UNIQUE INDEX ops_active_alert ON ops_alerts(code,entityId) WHERE resolvedAt IS NULL;
        CREATE TABLE ops_checks(id INTEGER PRIMARY KEY CHECK(id=1),attemptAt INTEGER NOT NULL,successAt INTEGER,metrics TEXT NOT NULL);
        CREATE TABLE ops_notifications(id TEXT PRIMARY KEY,recipient TEXT NOT NULL,locale TEXT NOT NULL,payload TEXT NOT NULL,createdAt INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,nextAttemptAt INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','failed')),sentAt INTEGER,errorCode TEXT);
        CREATE INDEX ops_notifications_due ON ops_notifications(state,nextAttemptAt);`);
      db.prepare("INSERT INTO schema_migrations VALUES(10,?)").run(
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  if (
    !db.prepare("SELECT version FROM schema_migrations WHERE version=11").get()
  ) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(
        "CREATE INDEX IF NOT EXISTS requests_pending_deployment ON requests(deploymentId) WHERE status='pending';CREATE INDEX IF NOT EXISTS deployments_ready_model ON deployments(modelId,healthAt) WHERE phase='ready' AND desiredState='running'",
      );
      db.prepare("INSERT INTO schema_migrations VALUES(11,?)").run(
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}
