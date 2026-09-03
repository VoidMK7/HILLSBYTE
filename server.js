require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();

const PORT = Number(process.env.PORT || 3000);
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me';
const BOT_USERNAME = process.env.BOT_USERNAME || '';

/* =========================================================
   APP
========================================================= */

app.use(express.json({ limit: '5mb' }));
app.use(express.static(__dirname));

/* =========================================================
   DATA DIRECTORY
========================================================= */

const dataDir = path.join(__dirname, 'data');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

/* =========================================================
   DATABASE
========================================================= */

const db = new Database(
  path.join(dataDir, 'hillsbyte.db')
);

db.pragma('journal_mode=WAL');

/* =========================================================
   DATABASE TABLES
========================================================= */

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT UNIQUE,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  email_verified INTEGER DEFAULT 0,
  balance REAL DEFAULT 0,
  pending_balance REAL DEFAULT 0,
  hillscoin REAL DEFAULT 0,
  referral_code TEXT UNIQUE,
  referred_by INTEGER,
  payment_address TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  reward REAL NOT NULL,
  reward_coin TEXT DEFAULT 'USD',
  url TEXT DEFAULT '#',
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS completions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  status TEXT DEFAULT 'completed',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS withdrawals(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  payment_address TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transactions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT DEFAULT 'USD',
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

/* =========================================================
   MIGRATION
   Add proof column if it doesn't already exist
========================================================= */

try {
  db.prepare(
    'ALTER TABLE completions ADD COLUMN proof TEXT'
  ).run();
} catch (e) {
  if (
    !String(e.message).includes(
      'duplicate column name'
    )
  ) {
    throw e;
  }
}

/* =========================================================
   STARTER TASKS
========================================================= */

if (
  db.prepare(
    'SELECT COUNT(*) n FROM tasks'
  ).get().n === 0
) {
  const insertTask = db.prepare(`
    INSERT INTO tasks(
      title,
      description,
      reward,
      reward_coin,
      url,
      active
    )
    VALUES(?,?,?,?,?,1)
  `);

  [
    [
      'Welcome Task',
      'Open the task page and follow its instructions.',
      0.25,
      'USD',
      'https://example.com'
    ],
    [
      'HillsByte Starter',
      'Read the campaign information.',
      0.10,
      'USD',
      'https://example.com'
    ],
    [
      'Community Task',
      'Visit the campaign page.',
      0.15,
      'USD',
      'https://example.com'
    ]
  ].forEach(task => {
    insertTask.run(...task);
  });
}

/* =========================================================
   REFERRAL CODE
========================================================= */

function ref() {
  let code;

  do {
    code =
      'HB' +
      crypto
        .randomBytes(4)
        .toString('hex')
        .toUpperCase();
  } while (
    db
      .prepare(
        'SELECT 1 FROM users WHERE referral_code=?'
      )
      .get(code)
  );

  return code;
}

/* =========================================================
   USER AUTH
========================================================= */

function reqUser(req) {
  const id = String(
    req.header('x-user-id') || ''
  );

  if (!id) {
    return null;
  }

  return db
    .prepare(
      'SELECT * FROM users WHERE id=?'
    )
    .get(id);
}

/* =========================================================
   CREATE / RETRIEVE USER
========================================================= */

function createUser(t, r) {
  let user = t.id
    ? db
        .prepare(
          'SELECT * FROM users WHERE telegram_id=?'
        )
        .get(String(t.id))
    : null;

  if (user) {
    return user;
  }

  let referredBy = null;

  if (r) {
    const referralUser = db
      .prepare(
        'SELECT id FROM users WHERE referral_code=?'
      )
      .get(
        String(r)
          .replace(/^ref_/i, '')
          .toUpperCase()
      );

    if (referralUser) {
      referredBy = referralUser.id;
    }
  }

  const result = db
    .prepare(`
      INSERT INTO users(
        telegram_id,
        username,
        first_name,
        last_name,
        referral_code,
        referred_by
      )
      VALUES(?,?,?,?,?,?)
    `)
    .run(
      t.id
        ? String(t.id)
        : 'demo-' + crypto.randomUUID(),
      t.username || 'demo_user',
      t.first_name || 'Demo',
      t.last_name || 'User',
      ref(),
      referredBy
    );

  if (referredBy) {
    db.prepare(`
      UPDATE users
      SET hillscoin=hillscoin+1
      WHERE id=?
    `).run(referredBy);

    db.prepare(`
      INSERT INTO transactions(
        user_id,
        type,
        amount,
        currency,
        note
      )
      VALUES(
        ?,
        'referral_bonus',
        1,
        'HBC',
        'Referral signup bonus'
      )
    `).run(referredBy);
  }

  return db
    .prepare(
      'SELECT * FROM users WHERE id=?'
    )
    .get(result.lastInsertRowid);
}

/* =========================================================
   AUTHENTICATION
========================================================= */

app.post('/api/auth', (req, res) => {
  try {
    const user = createUser(
      req.body?.telegramUser || {},
      req.body?.referral || ''
    );

    res.json({
      ok: true,
      user
    });
  } catch (e) {
    console.error(e);

    res.status(500).json({
      ok: false,
      error: 'Authentication failed'
    });
  }
});

/* =========================================================
   CURRENT USER
========================================================= */

app.get('/api/me', (req, res) => {
  const user = reqUser(req);

  if (!user) {
    return res.status(401).json({
      ok: false,
      error: 'Not authenticated'
    });
  }

  res.json({
    ok: true,
    user
  });
});

/* =========================================================
   PROFILE
========================================================= */

app.patch('/api/profile', (req, res) => {
  const user = reqUser(req);

  if (!user) {
    return res.status(401).json({
      ok: false,
      error: 'Not authenticated'
    });
  }

  const email = req.body?.email;
  const paymentAddress =
    req.body?.paymentAddress;

  if (
    email !== undefined &&
    String(email).length > 160
  ) {
    return res.status(400).json({
      ok: false,
      error: 'Email is too long'
    });
  }

  if (
    paymentAddress !== undefined &&
    String(paymentAddress).length > 120
  ) {
    return res.status(400).json({
      ok: false,
      error: 'Payment address is too long'
    });
  }

  db.prepare(`
    UPDATE users
    SET
      email=COALESCE(?,email),
      payment_address=COALESCE(?,payment_address)
    WHERE id=?
  `).run(
    email ?? null,
    paymentAddress ?? null,
    user.id
  );

  res.json({
    ok: true,
    user: db
      .prepare(
        'SELECT * FROM users WHERE id=?'
      )
      .get(user.id)
  });
});

/* =========================================================
   EMAIL VERIFICATION DEMO
========================================================= */

app.post(
  '/api/email/verify-demo',
  (req, res) => {
    const user = reqUser(req);

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: 'Not authenticated'
      });
    }

    if (!user.email) {
      return res.status(400).json({
        ok: false,
        error: 'Add an email first'
      });
    }

    db.prepare(`
      UPDATE users
      SET email_verified=1
      WHERE id=?
    `).run(user.id);

    res.json({
      ok: true
    });
  }
);

/* =========================================================
   USER TASKS
========================================================= */

app.get('/api/tasks', (req, res) => {
  const user = reqUser(req);

  if (!user) {
    return res.status(401).json({
      ok: false,
      error: 'Not authenticated'
    });
  }

  const tasks = db.prepare(`
    SELECT
      t.id,
      t.title,
      t.description,
      t.reward,
      t.reward_coin,
      t.url,
      COALESCE(
        c.status,
        'available'
      ) AS status,

      CASE
        WHEN c.status='approved'
        THEN 1
        ELSE 0
      END AS completed

    FROM tasks t

    LEFT JOIN completions c
      ON c.task_id=t.id
      AND c.user_id=?

    WHERE t.active=1

    ORDER BY t.id DESC
  `).all(user.id);

  res.json({
    ok: true,
    tasks
  });
});

/* =========================================================
   USER SUBMIT TASK PROOF
========================================================= */

app.post(
  '/api/tasks/:id/submit',
  (req, res) => {

    const user = reqUser(req);

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: 'Not authenticated'
      });
    }

    const task = db
      .prepare(`
        SELECT *
        FROM tasks
        WHERE id=?
        AND active=1
      `)
      .get(req.params.id);

    if (!task) {
      return res.status(404).json({
        ok: false,
        error: 'Task not found'
      });
    }

    const proof = String(
      req.body?.proof || ''
    ).trim();

    if (!proof) {
      return res.status(400).json({
        ok: false,
        error: 'Screenshot proof is required'
      });
    }

    if (proof.length > 4800000) {
      return res.status(400).json({
        ok: false,
        error: 'Screenshot is too large'
      });
    }

    const existing = db
      .prepare(`
        SELECT *
        FROM completions
        WHERE user_id=?
        AND task_id=?
      `)
      .get(
        user.id,
        task.id
      );

    if (existing) {

      if (
        existing.status ===
        'pending'
      ) {
        return res.status(409).json({
          ok: false,
          error:
            'This task is already pending review'
        });
      }

      if (
        existing.status ===
        'approved'
      ) {
        return res.status(409).json({
          ok: false,
          error:
            'Task already approved'
        });
      }

      if (
        existing.status ===
        'rejected'
      ) {
        db.prepare(`
          UPDATE completions

          SET
            status='pending',
            proof=?,
            created_at=CURRENT_TIMESTAMP

          WHERE user_id=?
          AND task_id=?
        `).run(
          proof,
          user.id,
          task.id
        );

        return res.json({
          ok: true,
          message:
            'Proof resubmitted for review'
        });
      }
    }

    db.prepare(`
      INSERT INTO completions(
        user_id,
        task_id,
        status,
        proof
      )
      VALUES(
        ?,
        ?,
        'pending',
        ?
      )
    `).run(
      user.id,
      task.id,
      proof
    );

    res.json({
      ok: true,
      message:
        'Proof submitted. Waiting for review.'
    });
  }
);

/* =========================================================
   TRANSACTIONS
========================================================= */

app.get(
  '/api/transactions',
  (req, res) => {

    const user = reqUser(req);

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: 'Not authenticated'
      });
    }

    const transactions = db
      .prepare(`
        SELECT *
        FROM transactions

        WHERE user_id=?

        ORDER BY id DESC

        LIMIT 100
      `)
      .all(user.id);

    res.json({
      ok: true,
      transactions
    });
  }
);

/* =========================================================
   WITHDRAWAL
========================================================= */

app.post(
  '/api/withdraw',
  (req, res) => {

    const user = reqUser(req);

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: 'Not authenticated'
      });
    }

    const amount =
      Number(req.body?.amount);

    const address = String(
      req.body?.paymentAddress ||
      user.payment_address ||
      ''
    ).trim();

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      return res.status(400).json({
        ok: false,
        error:
          'Invalid withdrawal amount'
      });
    }

    if (
      !/^0x[a-fA-F0-9]{40}$/.test(
        address
      )
    ) {
      return res.status(400).json({
        ok: false,
        error:
          'Enter a valid BEP20-compatible EVM address'
      });
    }

    if (amount < 1) {
      return res.status(400).json({
        ok: false,
        error:
          'Minimum withdrawal is $1 in this starter'
      });
    }

    if (amount > user.balance) {
      return res.status(400).json({
        ok: false,
        error:
          'Insufficient available balance'
      });
    }

    const transaction =
      db.transaction(() => {

        db.prepare(`
          UPDATE users

          SET
            balance=balance-?,
            payment_address=?

          WHERE id=?
        `).run(
          amount,
          address,
          user.id
        );

        db.prepare(`
          INSERT INTO withdrawals(
            user_id,
            amount,
            payment_address
          )

          VALUES(?,?,?)
        `).run(
          user.id,
          amount,
          address
        );

        db.prepare(`
          INSERT INTO transactions(
            user_id,
            type,
            amount,
            currency,
            note
          )

          VALUES(
            ?,
            'withdrawal',
            ?,
            'USD',
            'Withdrawal request'
          )
        `).run(
          user.id,
          amount
        );
      });

    transaction();

    res.json({
      ok: true,
      message:
        'Withdrawal request submitted'
    });
  }
);

/* =========================================================
   ADMIN AUTHENTICATION
========================================================= */

function admin(req, res, next) {

  if (
    req.header('x-admin-key') !==
    ADMIN_KEY
  ) {
    return res.status(403).json({
      ok: false,
      error: 'Forbidden'
    });
  }

  next();
}

/* =========================================================
   ADMIN OVERVIEW
========================================================= */

app.get(
  '/api/admin/overview',
  admin,
  (req, res) => {

    res.json({
      ok: true,

      users: db
        .prepare(
          'SELECT COUNT(*) n FROM users'
        )
        .get().n,

      pendingWithdrawals: db
        .prepare(`
          SELECT COUNT(*) n
          FROM withdrawals
          WHERE status='pending'
        `)
        .get().n,

      paidWithdrawals: db
        .prepare(`
          SELECT
            COALESCE(
              SUM(amount),
              0
            ) total

          FROM withdrawals

          WHERE status='paid'
        `)
        .get().total
    });
  }
);

/* =========================================================
   ADMIN — LIST ALL TASKS
========================================================= */

app.get(
  '/api/admin/tasks',
  admin,
  (req, res) => {

    const tasks = db
      .prepare(`
        SELECT
          t.id,
          t.title,
          t.description,
          t.reward,
          t.reward_coin,
          t.url,
          t.active,

          (
            SELECT COUNT(*)
            FROM completions c
            WHERE c.task_id=t.id
          ) AS submissions,

          (
            SELECT COUNT(*)
            FROM completions c
            WHERE c.task_id=t.id
            AND c.status='pending'
          ) AS pending_submissions

        FROM tasks t

        ORDER BY t.id DESC
      `)
      .all();

    res.json({
      ok: true,
      tasks
    });
  }
);

/* =========================================================
   ADMIN — ADD TASK
========================================================= */

app.post(
  '/api/admin/tasks',
  admin,
  (req, res) => {

    const title =
      String(
        req.body?.title || ''
      ).trim();

    const description =
      String(
        req.body?.description || ''
      ).trim();

    const url =
      String(
        req.body?.url || ''
      ).trim();

    const reward =
      Number(req.body?.reward);

    const rewardCoin =
      String(
        req.body?.reward_coin ||
        req.body?.rewardCoin ||
        'USD'
      ).trim();

    const active =
      req.body?.active === false
        ? 0
        : 1;

    if (!title) {
      return res.status(400).json({
        ok: false,
        error:
          'Task title is required'
      });
    }

    if (title.length > 200) {
      return res.status(400).json({
        ok: false,
        error:
          'Task title is too long'
      });
    }

    if (description.length > 5000) {
      return res.status(400).json({
        ok: false,
        error:
          'Task description is too long'
      });
    }

    if (
      !Number.isFinite(reward) ||
      reward <= 0
    ) {
      return res.status(400).json({
        ok: false,
        error:
          'Reward must be greater than zero'
      });
    }

    if (reward > 1000000) {
      return res.status(400).json({
        ok: false,
        error:
          'Reward is too large'
      });
    }

    if (rewardCoin.length > 20) {
      return res.status(400).json({
        ok: false,
        error:
          'Reward currency is too long'
      });
    }

    if (url) {
      try {
        const parsed =
          new URL(url);

        if (
          !['http:', 'https:']
            .includes(parsed.protocol)
        ) {
          throw new Error(
            'Invalid protocol'
          );
        }

      } catch {
        return res.status(400).json({
          ok: false,
          error:
            'Enter a valid task URL'
        });
      }
    }

    const result =
      db.prepare(`
        INSERT INTO tasks(
          title,
          description,
          reward,
          reward_coin,
          url,
          active
        )

        VALUES(?,?,?,?,?,?)
      `).run(
        title,
        description,
        reward,
        rewardCoin || 'USD',
        url || '#',
        active
      );

    const task =
      db.prepare(`
        SELECT *
        FROM tasks
        WHERE id=?
      `).get(
        result.lastInsertRowid
      );

    res.json({
      ok: true,
      message:
        'Task created successfully',
      task
    });
  }
);

/* =========================================================
   ADMIN — EDIT TASK
========================================================= */

app.patch(
  '/api/admin/tasks/:id',
  admin,
  (req, res) => {

    const task =
      db.prepare(`
        SELECT *
        FROM tasks
        WHERE id=?
 
