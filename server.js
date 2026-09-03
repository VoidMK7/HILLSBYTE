require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();

const PORT = Number(process.env.PORT || 3000);
const ADMIN_KEY = String(process.env.ADMIN_KEY || 'change-me');
const BOT_USERNAME = String(process.env.BOT_USERNAME || '');

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: false, limit: '5mb' }));
app.use(express.static(__dirname));

const dataDir = path.join(__dirname, 'data');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(
  path.join(dataDir, 'hillsbyte.db')
);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/* DATABASE */

db.exec(`
CREATE TABLE IF NOT EXISTS users (
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

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  reward REAL NOT NULL,
  reward_coin TEXT DEFAULT 'USD',
  url TEXT DEFAULT '#',
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS completions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  status TEXT DEFAULT 'pending',
  proof TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  payment_address TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT DEFAULT 'USD',
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

/* MIGRATIONS */

function columnExists(table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some(c => c.name === column);
}

if (!columnExists('completions', 'proof')) {
  db.prepare(
    "ALTER TABLE completions ADD COLUMN proof TEXT DEFAULT ''"
  ).run();
}

if (!columnExists('tasks', 'created_at')) {
  db.prepare(
    "ALTER TABLE tasks ADD COLUMN created_at TEXT DEFAULT CURRENT_TIMESTAMP"
  ).run();
}

/* STARTER TASKS */

const taskCount = db
  .prepare('SELECT COUNT(*) AS count FROM tasks')
  .get().count;

if (taskCount === 0) {
  const insertTask = db.prepare(`
    INSERT INTO tasks (
      title,
      description,
      reward,
      reward_coin,
      url,
      active
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const starterTasks = [
    [
      'Welcome Task',
      'Open the task page and follow the instructions.',
      0.25,
      'USD',
      'https://example.com',
      1
    ],
    [
      'HillsByte Starter',
      'Read the campaign information and follow the instructions.',
      0.10,
      'USD',
      'https://example.com',
      1
    ],
    [
      'Community Task',
      'Visit the campaign page and complete the required action.',
      0.15,
      'USD',
      'https://example.com',
      1
    ]
  ];

  for (const task of starterTasks) {
    insertTask.run(...task);
  }
}

/* HELPERS */

function generateReferralCode() {
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
        'SELECT id FROM users WHERE referral_code = ?'
      )
      .get(code)
  );

  return code;
}

function cleanReferral(value) {
  return String(value || '')
    .replace(/^ref_/i, '')
    .replace(/^startapp_/i, '')
    .trim()
    .toUpperCase();
}

function getUserById(id) {
  return db
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(id);
}

function reqUser(req) {
  const id = String(
    req.header('x-user-id') || ''
  ).trim();

  if (!id) return null;

  return getUserById(id);
}

function safeNumber(value) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function validBep20Address(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function validUrl(value) {
  if (!value) return true;

  try {
    const parsed = new URL(value);

    return (
      parsed.protocol === 'http:' ||
      parsed.protocol === 'https:'
    );
  } catch {
    return false;
  }
}

/* CREATE USER */

function createUser(
  telegramUser = {},
  referral = ''
) {
  if (telegramUser.id) {
    const existing = db
      .prepare(`
        SELECT *
        FROM users
        WHERE telegram_id = ?
      `)
      .get(String(telegramUser.id));

    if (existing) {
      return existing;
    }
  }

  let referredBy = null;

  const referralCode =
    cleanReferral(referral);

  if (referralCode) {
    const referralUser = db
      .prepare(`
        SELECT id
        FROM users
        WHERE referral_code = ?
      `)
      .get(referralCode);

    if (referralUser) {
      referredBy = referralUser.id;
    }
  }

  const telegramId =
    telegramUser.id
      ? String(telegramUser.id)
      : 'demo-' + crypto.randomUUID();

  const username =
    String(
      telegramUser.username ||
      'demo_user'
    ).slice(0, 100);

  const firstName =
    String(
      telegramUser.first_name ||
      'Demo'
    ).slice(0, 100);

  const lastName =
    String(
      telegramUser.last_name ||
      'User'
    ).slice(0, 100);

  const newReferralCode =
    generateReferralCode();

  const create = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO users (
        telegram_id,
        username,
        first_name,
        last_name,
        referral_code,
        referred_by
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      telegramId,
      username,
      firstName,
      lastName,
      newReferralCode,
      referredBy
    );

    if (referredBy) {
      db.prepare(`
        UPDATE users
        SET hillscoin = hillscoin + 1
        WHERE id = ?
      `).run(referredBy);

      db.prepare(`
        INSERT INTO transactions (
          user_id,
          type,
          amount,
          currency,
          note
        )
        VALUES (
          ?,
          'referral_bonus',
          1,
          'HBC',
          'Referral signup bonus'
        )
      `).run(referredBy);
    }

    return result.lastInsertRowid;
  });

  return getUserById(create());
}
/* USER API */

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
  } catch (error) {
    console.error('AUTH ERROR:', error);

    res.status(500).json({
      ok: false,
      error: 'Authentication failed'
    });
  }
});

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

/* PROFILE */

app.patch('/api/profile', (req, res) => {
  const user = reqUser(req);

  if (!user) {
    return res.status(401).json({
      ok: false,
      error: 'Not authenticated'
    });
  }

  const email =
    req.body?.email !== undefined
      ? String(req.body.email).trim()
      : undefined;

  const paymentAddress =
    req.body?.paymentAddress !== undefined
      ? String(req.body.paymentAddress).trim()
      : undefined;

  if (email !== undefined && email.length > 160) {
    return res.status(400).json({
      ok: false,
      error: 'Email is too long'
    });
  }

  if (
    paymentAddress !== undefined &&
    paymentAddress.length > 120
  ) {
    return res.status(400).json({
      ok: false,
      error: 'Payment address is too long'
    });
  }

  if (
    paymentAddress !== undefined &&
    paymentAddress !== '' &&
    !validBep20Address(paymentAddress)
  ) {
    return res.status(400).json({
      ok: false,
      error: 'Enter a valid BEP20-compatible address'
    });
  }

  db.prepare(`
    UPDATE users
    SET
      email = COALESCE(?, email),
      payment_address = COALESCE(?, payment_address)
    WHERE id = ?
  `).run(
    email === undefined ? null : email,
    paymentAddress === undefined
      ? null
      : paymentAddress,
    user.id
  );

  res.json({
    ok: true,
    user: getUserById(user.id)
  });
});

/* DEMO EMAIL VERIFICATION */

app.post('/api/email/verify-demo', (req, res) => {
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
    SET email_verified = 1
    WHERE id = ?
  `).run(user.id);

  res.json({
    ok: true,
    user: getUserById(user.id)
  });
});

/* TASKS */

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
      t.active,

      COALESCE(
        (
          SELECT c.status
          FROM completions c
          WHERE
            c.user_id = ?
            AND c.task_id = t.id
          ORDER BY c.id DESC
          LIMIT 1
        ),
        'available'
      ) AS status,

      CASE
        WHEN EXISTS (
          SELECT 1
          FROM completions c
          WHERE
            c.user_id = ?
            AND c.task_id = t.id
            AND c.status = 'approved'
        )
        THEN 1
        ELSE 0
      END AS completed

    FROM tasks t

    WHERE t.active = 1

    ORDER BY t.id DESC
  `).all(
    user.id,
    user.id
  );

  res.json({
    ok: true,
    tasks
  });
});

/* SUBMIT SCREENSHOT PROOF */

app.post('/api/tasks/:id/submit', (req, res) => {
  const user = reqUser(req);

  if (!user) {
    return res.status(401).json({
      ok: false,
      error: 'Not authenticated'
    });
  }

  const task = db.prepare(`
    SELECT *
    FROM tasks
    WHERE id = ?
      AND active = 1
  `).get(req.params.id);

  if (!task) {
    return res.status(404).json({
      ok: false,
      error: 'Task not found'
    });
  }

  const proof =
    String(req.body?.proof || '').trim();

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

  const existing = db.prepare(`
    SELECT *
    FROM completions
    WHERE
      user_id = ?
      AND task_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(
    user.id,
    task.id
  );

  if (existing) {

    if (existing.status === 'pending') {
      return res.status(409).json({
        ok: false,
        error: 'This task is already pending review'
      });
    }

    if (existing.status === 'approved') {
      return res.status(409).json({
        ok: false,
        error: 'This task has already been approved'
      });
    }

    if (existing.status === 'rejected') {

      db.prepare(`
        UPDATE completions
        SET
          status = 'pending',
          proof = ?,
          created_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        proof,
        existing.id
      );

      return res.json({
        ok: true,
        message: 'Proof resubmitted for review'
      });
    }
  }

  db.prepare(`
    INSERT INTO completions (
      user_id,
      task_id,
      status,
      proof
    )
    VALUES (?, ?, 'pending', ?)
  `).run(
    user.id,
    task.id,
    proof
  );

  res.json({
    ok: true,
    message: 'Proof submitted. Waiting for review.'
  });
});

/* TRANSACTIONS */

app.get('/api/transactions', (req, res) => {
  const user = reqUser(req);

  if (!user) {
    return res.status(401).json({
      ok: false,
      error: 'Not authenticated'
    });
  }

  const transactions = db.prepare(`
    SELECT *
    FROM transactions
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT 100
  `).all(user.id);

  res.json({
    ok: true,
    transactions
  });
});

/* WITHDRAWAL */

app.post('/api/withdraw', (req, res) => {
  const user = reqUser(req);

  if (!user) {
    return res.status(401).json({
      ok: false,
      error: 'Not authenticated'
    });
  }

  const amount =
    safeNumber(req.body?.amount);

  const address = String(
    req.body?.paymentAddress ||
    user.payment_address ||
    ''
  ).trim();

  if (amount === null || amount <= 0) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid withdrawal amount'
    });
  }

  if (amount < 1) {
    return res.status(400).json({
      ok: false,
      error: 'Minimum withdrawal is $1'
    });
  }

  if (!validBep20Address(address)) {
    return res.status(400).json({
      ok: false,
      error: 'Enter a valid BEP20-compatible EVM address'
    });
  }

  if (amount > Number(user.balance)) {
    return res.status(400).json({
      ok: false,
      error: 'Insufficient available balance'
    });
  }

  try {

    const withdrawalId =
      db.transaction(() => {

        const result = db.prepare(`
          UPDATE users
          SET
            balance = balance - ?,
            payment_address = ?
          WHERE
            id = ?
            AND balance >= ?
        `).run(
          amount,
          address,
          user.id,
          amount
        );

        if (result.changes !== 1) {
          throw new Error(
            'Insufficient balance'
          );
        }

        const withdrawal =
          db.prepare(`
            INSERT INTO withdrawals (
              user_id,
              amount,
              payment_address,
              status
            )
            VALUES (?, ?, ?, 'pending')
          `).run(
            user.id,
            amount,
            address
          );

        db.prepare(`
          INSERT INTO transactions (
            user_id,
            type,
            amount,
            currency,
            note
          )
          VALUES (
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

        return withdrawal.lastInsertRowid;
      })();

    res.json({
      ok: true,
      withdrawalId,
      message: 'Withdrawal request submitted'
    });

  } catch (error) {

    console.error(
      'WITHDRAW ERROR:',
      error
    );

    res.status(500).json({
      ok: false,
      error: 'Unable to create withdrawal'
    });
  }
});

/* ADMIN AUTH */

function admin(req, res, next) {
  const key =
    String(
      req.header('x-admin-key') || ''
    );

  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(403).json({
      ok: false,
      error: 'Forbidden'
    });
  }

  next();
}

/* ADMIN OVERVIEW */

app.get(
  '/api/admin/overview',
  admin,
  (req, res) => {

    const users =
      db.prepare(
        'SELECT COUNT(*) AS n FROM users'
      ).get().n;

    const tasks =
      db.prepare(
        'SELECT COUNT(*) AS n FROM tasks'
      ).get().n;

    const activeTasks =
      db.prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE active = 1"
      ).get().n;

    const pendingWithdrawals =
      db.prepare(
        "SELECT COUNT(*) AS n FROM withdrawals WHERE status = 'pending'"
      ).get().n;

    const pendingSubmissions =
      db.prepare(
        "SELECT COUNT(*) AS n FROM completions WHERE status = 'pending'"
      ).get().n;

    const paidWithdrawals =
      db.prepare(`
        SELECT COALESCE(
          SUM(amount), 0
        ) AS total
        FROM withdrawals
        WHERE status = 'paid'
      `).get().total;

    const approvedRewards =
      db.prepare(`
        SELECT COALESCE(
          SUM(amount), 0
        ) AS total
        FROM transactions
        WHERE type = 'task_reward'
      `).get().total;

    res.json({
      ok: true,
      users,
      tasks,
      activeTasks,
      pendingWithdrawals,
      pendingSubmissions,
      paidWithdrawals,
      approvedRewards
    });
  }
);

/* ADMIN TASK LIST */

app.get(
  '/api/admin/tasks',
  admin,
  (req, res) => {

    const tasks = db.prepare(`
      SELECT
        t.id,
        t.title,
        t.description,
        t.reward,
        t.reward_coin,
        t.url,
        t.active,
        t.created_at,

        (
          SELECT COUNT(*)
          FROM completions c
          WHERE c.task_id = t.id
        ) AS submissions,

        (
          SELECT COUNT(*)
          FROM completions c
          WHERE
            c.task_id = t.id
            AND c.status = 'pending'
        ) AS pending_submissions,

        (
          SELECT COUNT(*)
          FROM completions c
          WHERE
            c.task_id = t.id
            AND c.status = 'approved'
        ) AS approved_submissions

      FROM tasks t

      ORDER BY t.id DESC
    `).all();

    res.json({
      ok: true,
      tasks
    });
  }
);

/* ADMIN ADD TASK */

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
      safeNumber(req.body?.reward);

    const rewardCoin =
      String(
        req.body?.reward_coin ??
        req.body?.rewardCoin ??
        'USD'
      ).trim();

    const active =
      req.body?.active === false ||
      req.body?.active === 0
        ? 0
        : 1;

    if (!title) {
      return res.status(400).json({
        ok: false,
        error: 'Task title is required'
      });
    }

    if (
      reward === null ||
      reward <= 0
    ) {
      return res.status(400).json({
        ok: false,
        error: 'Reward must be greater than zero'
      });
    }

    if (!validUrl(url)) {
      return res.status(400).json({
        ok: false,
        error: 'Enter a valid task URL'
      });
    }

    const result = db.prepare(`
      INSERT INTO tasks (
        title,
        description,
        reward,
        reward_coin,
        url,
        active
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      title,
      description,
      reward,
      rewardCoin,
      url || '#',
      active
    );

    res.json({
      ok: true,
      task: db.prepare(
        'SELECT * FROM tasks WHERE id = ?'
      ).get(result.lastInsertRowid)
    });
  }
);
/* ADMIN EDIT TASK */

app.patch(
  '/api/admin/tasks/:id',
  admin,
  (req, res) => {

    const taskId =
      Number(req.params.id);

    if (!Number.isInteger(taskId)) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid task ID'
      });
    }

    const existing =
      db.prepare(
        'SELECT * FROM tasks WHERE id = ?'
      ).get(taskId);

    if (!existing) {
      return res.status(404).json({
        ok: false,
        error: 'Task not found'
      });
    }

    const title =
      req.body?.title !== undefined
        ? String(req.body.title).trim()
        : existing.title;

    const description =
      req.body?.description !== undefined
        ? String(req.body.description).trim()
        : existing.description;

    const url =
      req.body?.url !== undefined
        ? String(req.body.url).trim()
        : existing.url;

    const reward =
      req.body?.reward !== undefined
        ? safeNumber(req.body.reward)
        : Number(existing.reward);

    const rewardCoin =
      req.body?.reward_coin !== undefined
        ? String(req.body.reward_coin).trim()
        : req.body?.rewardCoin !== undefined
          ? String(req.body.rewardCoin).trim()
          : existing.reward_coin;

    let active = existing.active;

    if (req.body?.active !== undefined) {
      active =
        req.body.active === false ||
        req.body.active === 0
          ? 0
          : 1;
    }

    if (!title) {
      return res.status(400).json({
        ok: false,
        error: 'Task title is required'
      });
    }

    if (
      reward === null ||
      reward <= 0
    ) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid reward'
      });
    }

    if (!validUrl(url)) {
      return res.status(400).json({
        ok: false,
        error: 'Enter a valid task URL'
      });
    }

    db.prepare(`
      UPDATE tasks
      SET
        title = ?,
        description = ?,
        reward = ?,
        reward_coin = ?,
        url = ?,
        active = ?
      WHERE id = ?
    `).run(
      title,
      description,
      reward,
      rewardCoin,
      url || '#',
      active,
      taskId
    );

    res.json({
      ok: true,
      task: db.prepare(
        'SELECT * FROM tasks WHERE id = ?'
      ).get(taskId)
    });
  }
);

/* ACTIVATE / DEACTIVATE TASK */

app.post(
  '/api/admin/tasks/:id/toggle',
  admin,
  (req, res) => {

    const taskId =
      Number(req.params.id);

    if (!Number.isInteger(taskId)) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid task ID'
      });
    }

    const task =
      db.prepare(
        'SELECT * FROM tasks WHERE id = ?'
      ).get(taskId);

    if (!task) {
      return res.status(404).json({
        ok: false,
        error: 'Task not found'
      });
    }

    const newStatus =
      task.active ? 0 : 1;

    db.prepare(`
      UPDATE tasks
      SET active = ?
      WHERE id = ?
    `).run(
      newStatus,
      taskId
    );

    res.json({
      ok: true,
      active: newStatus,
      task: db.prepare(
        'SELECT * FROM tasks WHERE id = ?'
      ).get(taskId)
    });
  }
);

/* DELETE TASK */

app.delete(
  '/api/admin/tasks/:id',
  admin,
  (req, res) => {

    const taskId =
      Number(req.params.id);

    if (!Number.isInteger(taskId)) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid task ID'
      });
    }

    const task =
      db.prepare(
        'SELECT * FROM tasks WHERE id = ?'
      ).get(taskId);

    if (!task) {
      return res.status(404).json({
        ok: false,
        error: 'Task not found'
      });
    }

    const remove =
      db.transaction(() => {

        db.prepare(`
          DELETE FROM completions
          WHERE task_id = ?
        `).run(taskId);

        db.prepare(`
          DELETE FROM tasks
          WHERE id = ?
        `).run(taskId);
      });

    remove();

    res.json({
      ok: true,
      message: 'Task deleted'
    });
  }
);

/* ADMIN TASK SUBMISSIONS */

app.get(
  '/api/admin/task-submissions',
  admin,
  (req, res) => {

    const submissions =
      db.prepare(`
        SELECT
          c.id,
          c.user_id,
          c.task_id,
          c.status,
          c.proof,
          c.created_at,

          t.title AS task_title,
          t.reward,
          t.reward_coin,

          u.username,
          u.first_name,
          u.last_name,
          u.telegram_id

        FROM completions c

        INNER JOIN tasks t
          ON t.id = c.task_id

        INNER JOIN users u
          ON u.id = c.user_id

        ORDER BY c.id DESC

        LIMIT 500
      `).all();

    res.json({
      ok: true,
      submissions
    });
  }
);

/* APPROVE / REJECT TASK PROOF */

app.post(
  '/api/admin/task-submissions/:id/status',
  admin,
  (req, res) => {

    const submissionId =
      Number(req.params.id);

    const requestedStatus =
      String(
        req.body?.status || ''
      )
      .trim()
      .toLowerCase();

    if (!Number.isInteger(submissionId)) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid submission ID'
      });
    }

    if (
      !['approved', 'rejected']
        .includes(requestedStatus)
    ) {
      return res.status(400).json({
        ok: false,
        error:
          'Status must be approved or rejected'
      });
    }

    const submission =
      db.prepare(`
        SELECT
          c.*,
          t.title,
          t.reward,
          t.reward_coin,
          u.username

        FROM completions c

        INNER JOIN tasks t
          ON t.id = c.task_id

        INNER JOIN users u
          ON u.id = c.user_id

        WHERE c.id = ?
      `).get(submissionId);

    if (!submission) {
      return res.status(404).json({
        ok: false,
        error: 'Submission not found'
      });
    }

    if (submission.status !== 'pending') {
      return res.status(409).json({
        ok: false,
        error:
          `Submission is already ${submission.status}`
      });
    }

    try {

      db.transaction(() => {

        if (
          requestedStatus === 'approved'
        ) {

          db.prepare(`
            UPDATE completions
            SET status = 'approved'
            WHERE id = ?
              AND status = 'pending'
          `).run(submissionId);

          if (
            String(
              submission.reward_coin
            ).toUpperCase() === 'HBC'
          ) {

            db.prepare(`
              UPDATE users
              SET hillscoin =
                hillscoin + ?
              WHERE id = ?
            `).run(
              submission.reward,
              submission.user_id
            );

          } else {

            db.prepare(`
              UPDATE users
              SET balance =
                balance + ?
              WHERE id = ?
            `).run(
              submission.reward,
              submission.user_id
            );
          }

          db.prepare(`
            INSERT INTO transactions (
              user_id,
              type,
              amount,
              currency,
              note
            )
            VALUES (
              ?,
              'task_reward',
              ?,
              ?,
              ?
            )
          `).run(
            submission.user_id,
            submission.reward,
            submission.reward_coin,
            `Approved task: ${submission.title}`
          );

        } else {

          db.prepare(`
            UPDATE completions
            SET status = 'rejected'
            WHERE id = ?
              AND status = 'pending'
          `).run(submissionId);
        }

      })();

      res.json({
        ok: true,
        status: requestedStatus
      });

    } catch (error) {

      console.error(
        'SUBMISSION STATUS ERROR:',
        error
      );

      res.status(500).json({
        ok: false,
        error:
          'Unable to update submission'
      });
    }
  }
);

/* ADMIN WITHDRAWALS */

app.get(
  '/api/admin/withdrawals',
  admin,
  (req, res) => {

    const withdrawals =
      db.prepare(`
        SELECT
          w.id,
          w.user_id,
          w.amount,
          w.payment_address,
          w.status,
          w.created_at,

          u.username,
          u.first_name,
          u.last_name,
          u.telegram_id

        FROM withdrawals w

        INNER JOIN users u
          ON u.id = w.user_id

        ORDER BY w.id DESC

        LIMIT 500
      `).all();

    res.json({
      ok: true,
      withdrawals
    });
  }
);

/* PAY / REJECT WITHDRAWAL */

app.post(
  '/api/admin/withdrawals/:id/status',
  admin,
  (req, res) => {

    const withdrawalId =
      Number(req.params.id);

    const requestedStatus =
      String(
        req.body?.status || ''
      )
      .trim()
      .toLowerCase();

    if (!Number.isInteger(withdrawalId)) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid withdrawal ID'
      });
    }

    if (
      !['paid', 'rejected']
        .includes(requestedStatus)
    ) {
      return res.status(400).json({
        ok: false,
        error:
          'Status must be paid or rejected'
      });
    }

    const withdrawal =
      db.prepare(`
        SELECT *
        FROM withdrawals
        WHERE id = ?
      `).get(withdrawalId);

    if (!withdrawal) {
      return res.status(404).json({
        ok: false,
        error: 'Withdrawal not found'
      });
    }

    if (withdrawal.status !== 'pending') {
      return res.status(409).json({
        ok: false,
        error:
          `Withdrawal is already ${withdrawal.status}`
      });
    }

    try {

      db.transaction(() => {

        if (
          requestedStatus === 'paid'
        ) {

          db.prepare(`
            UPDATE withdrawals
            SET status = 'paid'
            WHERE id = ?
              AND status = 'pending'
          `).run(withdrawalId);

          db.prepare(`
            INSERT INTO transactions (
              user_id,
              type,
              amount,
              currency,
              note
            )
            VALUES (
              ?,
              'withdrawal_paid',
              ?,
              'USD',
              'Withdrawal marked as paid'
            )
          `).run(
            withdrawal.user_id,
            withdrawal.amount
          );

        } else {

          db.prepare(`
            UPDATE withdrawals
            SET status = 'rejected'
            WHERE id = ?
              AND status = 'pending'
          `).run(withdrawalId);

          db.prepare(`
            UPDATE users
            SET balance =
              balance + ?
            WHERE id = ?
          `).run(
            withdrawal.amount,
            withdrawal.user_id
          );

          db.prepare(`
            INSERT INTO transactions (
              user_id,
              type,
              amount,
              currency,
              note
            )
            VALUES (
              ?,
              'withdrawal_refund',
              ?,
              'USD',
              'Rejected withdrawal refunded'
            )
          `).run(
            withdrawal.user_id,
            withdrawal.amount
          );
        }

      })();

      res.json({
        ok: true,
        status: requestedStatus
      });

    } catch (error) {

      console.error(
        'WITHDRAWAL STATUS ERROR:',
        error
      );

      res.status(500).json({
        ok: false,
        error:
          'Unable to update withdrawal'
      });
    }
  }
);

/* CONFIG */

app.get('/api/config', (req, res) => {

  res.json({
    ok: true,
    bot_username: BOT_USERNAME,
    botUsername: BOT_USERNAME,
    min_withdrawal: 1
  });
});

/* HEALTH CHECK */

app.get('/api/health', (req, res) => {

  res.json({
    ok: true,
    service: 'HillsByte',
    timestamp:
      new Date().toISOString()
  });
});

/* FRONTEND */

app.use((req, res) => {

  if (req.path.startsWith('/api/')) {
    return res.status(404).json({
      ok: false,
      error: 'API endpoint not found'
    });
  }

  res.sendFile(
    path.join(
      __dirname,
      'index.html'
    )
  );
});

/* ERROR HANDLER */

app.use(
  (err, req, res, next) => {

    console.error(
      'SERVER ERROR:',
      err
    );

    if (res.headersSent) {
      return next(err);
    }

    res.status(500).json({
      ok: false,
      error: 'Internal server error'
    });
  }
);

/* START SERVER */

app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `HillsByte server running on port ${PORT}`
    );
  }
);
