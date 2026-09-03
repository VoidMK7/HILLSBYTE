const S = {
  user: null,
  config: null,
  startedTasks: new Set()
};

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

/* =========================
   TELEGRAM
========================= */

function tg() {
  return window.Telegram?.WebApp?.initDataUnsafe?.user || null;
}

function ref() {
  const p = new URLSearchParams(location.search);
  return p.get('ref') || p.get('startapp') || '';
}

/* =========================
   API
========================= */

async function api(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  if (S.user?.id) {
    headers['x-user-id'] = S.user.id;
  }

  const response = await fetch(url, {
    ...options,
    headers
  });

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error('Server returned an invalid response');
  }

  if (!response.ok || data.ok === false) {
    throw new Error(data.error || 'Request failed');
  }

  return data;
}

/* =========================
   HELPERS
========================= */

function money(value) {
  return '$' + Number(value || 0).toFixed(2);
}

function toast(message) {
  const t = $('#toast');

  if (!t) {
    alert(message);
    return;
  }

  t.textContent = message;
  t.classList.add('show');

  clearTimeout(window.__toastTimer);

  window.__toastTimer = setTimeout(() => {
    t.classList.remove('show');
  }, 2200);
}

function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    }[character])
  );
}

function safe(url) {
  try {
    const x = new URL(url, location.origin);

    if (!['http:', 'https:'].includes(x.protocol)) {
      return '#';
    }

    return x.href;
  } catch {
    return '#';
  }
}

/* =========================
   USER DISPLAY
========================= */

function render() {
  const u = S.user;

  if (!u) return;

  if ($('#balance')) {
    $('#balance').textContent = money(u.balance);
  }

  if ($('#pending')) {
    $('#pending').textContent = money(u.pending_balance);
  }

  if ($('#hillscoin')) {
    $('#hillscoin').textContent =
      Number(u.hillscoin || 0).toFixed(2) + ' HBC';
  }

  if ($('#lifetime')) {
    $('#lifetime').textContent =
      money((u.balance || 0) + (u.pending_balance || 0));
  }

  if ($('#refCode')) {
    $('#refCode').textContent =
      u.referral_code || '—';
  }

  if ($('#name')) {
    $('#name').textContent =
      [u.first_name, u.last_name]
        .filter(Boolean)
        .join(' ') || 'User';
  }

  if ($('#username')) {
    $('#username').textContent =
      u.username ? '@' + u.username : 'Telegram user';
  }

  if ($('#avatar')) {
    $('#avatar').textContent =
      (u.first_name || 'H')[0].toUpperCase();
  }

  if ($('#tgid')) {
    $('#tgid').textContent =
      u.telegram_id || 'Browser demo';
  }

  if ($('#email')) {
    $('#email').value = u.email || '';
  }

  if ($('#address')) {
    $('#address').value =
      u.payment_address || '';
  }

  if ($('#withdrawAddress')) {
    $('#withdrawAddress').value =
      u.payment_address || '';
  }

  if ($('#available')) {
    $('#available').textContent =
      money(u.balance);
  }
}

/* =========================
   AUTH
========================= */

async function auth() {
  const data = await api('/api/auth', {
    method: 'POST',
    body: JSON.stringify({
      telegramUser: tg(),
      referral: ref()
    })
  });

  S.user = data.user;

  S.config = await api('/api/config');

  render();
}

/* =========================
   PAGE NAVIGATION
========================= */

function page(name) {
  $$('.page').forEach(section => {
    section.classList.toggle(
      'active',
      section.id === name
    );
  });

  $$('nav button').forEach(button => {
    button.classList.toggle(
      'active',
      button.dataset.page === name
    );
  });

  if (name === 'tasks') {
    tasks();
  }

  if (name === 'history') {
    history();
  }

  render();

  window.scrollTo(0, 0);
}

/* =========================
   TASKS
========================= */

async function tasks() {
  try {
    const data = await api('/api/tasks');

    const container = $('#taskList');

    if (!container) return;

    if (!data.tasks || data.tasks.length === 0) {
      container.innerHTML =
        '<div class="card">No tasks available.</div>';

      return;
    }

    container.innerHTML = data.tasks
      .map(taskCard)
      .join('');

  } catch (error) {
    toast(error.message);
  }
}

/*
  Build one task card.

  Status:
  available
  pending
  approved
  rejected
*/

function taskCard(task) {
  const status = task.status || 'available';

  /* Already approved */
  if (status === 'approved') {
    return `
      <article class="card task">
        <div class="tasktop">
          <div>
            <h3>${esc(task.title)}</h3>
            <p>${esc(task.description)}</p>
          </div>

          <b class="reward">
            +${money(task.reward)}
          </b>
        </div>

        <div class="actions">
          <button
            class="secondary"
            disabled
          >
            ✓ Approved
          </button>
        </div>
      </article>
    `;
  }

  /* Waiting for admin */
  if (status === 'pending') {
    return `
      <article class="card task">
        <div class="tasktop">
          <div>
            <h3>${esc(task.title)}</h3>
            <p>${esc(task.description)}</p>
          </div>

          <b class="reward">
            +${money(task.reward)}
          </b>
        </div>

        <div class="actions">
          <button
            class="secondary"
            disabled
          >
            ⏳ Pending Review
          </button>
        </div>
      </article>
    `;
  }

  /*
    Rejected submissions can be submitted again.
  */
  if (status === 'rejected') {
    return `
      <article class="card task">
        <div class="tasktop">
          <div>
            <h3>${esc(task.title)}</h3>
            <p>${esc(task.description)}</p>
          </div>

          <b class="reward">
            +${money(task.reward)}
          </b>
        </div>

        <div class="actions">

          <a
            class="secondary"
            href="${safe(task.url)}"
            target="_blank"
            rel="noopener"
            onclick="markStarted(${task.id})"
          >
            Open Task
          </a>

          <button
            class="primary"
            onclick="showProof(${task.id})"
          >
            Submit Again
          </button>

        </div>

        <small class="task-status rejected-status">
          ✕ Previous proof was rejected
        </small>
      </article>
    `;
  }

  /*
    Normal available task.
  */

  const started =
    S.startedTasks.has(String(task.id));

  if (!started) {
    return `
      <article class="card task">
        <div class="tasktop">
          <div>
            <h3>${esc(task.title)}</h3>
            <p>${esc(task.description)}</p>
          </div>

          <b class="reward">
            +${money(task.reward)}
          </b>
        </div>

        <div class="actions">

          <button
            class="primary"
            onclick="startTask(${task.id})"
          >
            START
          </button>

        </div>
      </article>
    `;
  }

  /*
    User has started the task.

    Now COMPLETE becomes available.
  */

  return `
    <article class="card task">
      <div class="tasktop">
        <div>
          <h3>${esc(task.title)}</h3>
          <p>${esc(task.description)}</p>
        </div>

        <b class="reward">
          +${money(task.reward)}
        </b>
      </div>

      <div class="actions">

        <a
          class="secondary"
          href="${safe(task.url)}"
          target="_blank"
          rel="noopener"
        >
          Open Again
        </a>

        <button
          class="primary"
          onclick="completeTask(${task.id})"
        >
          COMPLETE
        </button>

      </div>

      <small class="task-status">
        Task started — complete it when you're done.
      </small>
    </article>
  `;
}

/* =========================
   START TASK
========================= */

function startTask(id) {
  /*
    START does NOT call the backend.

    Therefore:
    - no reward
    - no completion
    - no transaction
    - no balance change
  */

  S.startedTasks.add(String(id));

  tasks();

  /*
    Find the task URL from the rendered task.

    We reload the task list so the UI changes
    immediately from START to COMPLETE.
  */

  setTimeout(async () => {
    try {
      const data = await api('/api/tasks');

      const task = data.tasks.find(
        item => Number(item.id) === Number(id)
      );

      if (task && task.url) {
        window.open(
          safe(task.url),
          '_blank',
          'noopener'
        );
      }
    } catch (error) {
      toast(error.message);
    }
  }, 100);
}

/*
  Used when opening a task from a rejected submission.
*/
function markStarted(id) {
  S.startedTasks.add(String(id));
}

/* =========================
   COMPLETE TASK
========================= */

function completeTask(id) {
  /*
    IMPORTANT:

    This does NOT give a reward.

    It only opens the proof submission interface.
  */

  showProof(id);
}

/* =========================
   PROOF UPLOAD UI
========================= */

async function showProof(id) {
  /*
    We create the proof dialog dynamically.

    This means you don't have to add
    another HTML modal manually.
  */

  let modal = $('#proofModal');

  if (!modal) {
    modal = document.createElement('div');

    modal.id = 'proofModal';

    modal.innerHTML = `
      <div class="proof-backdrop">

        <div class="proof-box">

          <button
            type="button"
            class="proof-close"
            onclick="closeProof()"
          >
            ×
          </button>

          <h2>Submit Task Proof</h2>

          <p>
            Upload a screenshot showing that you
            completed the task.
          </p>

          <label class="proof-upload">

            <span id="proofLabel">
              📷 Choose Screenshot
            </span>

            <input
              id="proofFile"
              type="file"
              accept="image/*"
              hidden
            >

          </label>

          <img
            id="proofPreview"
            style="
              display:none;
              width:100%;
              max-height:300px;
              object-fit:contain;
              margin-top:12px;
              border-radius:12px;
            "
          >

          <button
            id="submitProofButton"
            type="button"
            class="primary"
            style="width:100%;margin-top:14px"
            onclick="submitProof()"
          >
            SUBMIT PROOF
          </button>

          <p
            id="proofMessage"
            style="margin-top:10px"
          ></p>

        </div>

      </div>
    `;

    document.body.appendChild(modal);

    addProofStyles();

    $('#proofFile').addEventListener(
      'change',
      previewProof
    );
  }

  modal.dataset.taskId = String(id);

  $('#proofMessage').textContent = '';

  $('#proofFile').value = '';

  $('#proofPreview').style.display = 'none';

  $('#proofLabel').textContent =
    '📷 Choose Screenshot';

  modal.style.display = 'flex';
}

/* =========================
   PROOF PREVIEW
========================= */

function previewProof(event) {
  const file = event.target.files?.[0];

  if (!file) return;

  if (!file.type.startsWith('image/')) {
    toast('Please select an image');
    event.target.value = '';
    return;
  }

  const reader = new FileReader();

  reader.onload = () => {
    $('#proofPreview').src =
      reader.result;

    $('#proofPreview').style.display =
      'block';

    $('#proofLabel').textContent =
      '✓ Screenshot selected';
  };

  reader.readAsDataURL(file);
}

/* =========================
   SUBMIT PROOF
========================= */

async function submitProof() {
  const modal = $('#proofModal');

  if (!modal) return;

  const taskId =
    modal.dataset.taskId;

  const file =
    $('#proofFile')?.files?.[0];

  const message =
    $('#proofMessage');

  const button =
    $('#submitProofButton');

  if (!file) {
    message.textContent =
      'Please choose a screenshot first.';

    return;
  }

  if (!file.type.startsWith('image/')) {
    message.textContent =
      'Please select a valid image.';

    return;
  }

  try {
    button.disabled = true;

    button.textContent =
      'Uploading...';

    message.textContent =
      'Preparing screenshot...';

    /*
      Compress the screenshot before sending it.
      This keeps the request comfortably below
      the server's 5MB JSON limit.
    */

    const proof =
      await compressImage(file);

    message.textContent =
      'Submitting proof...';

    const data = await api(
      '/api/tasks/' +
      encodeURIComponent(taskId) +
      '/submit',
      {
        method: 'POST',
        body: JSON.stringify({
          proof
        })
      }
    );

    message.textContent =
      data.message ||
      'Proof submitted for review.';

    button.textContent =
      'Submitted ✓';

    S.startedTasks.delete(
      String(taskId)
    );

    toast(
      'Proof submitted. Waiting for review.'
    );

    /*
      Refresh task status.
    */

    await tasks();

    /*
      Close after a short delay.
    */

    setTimeout(() => {
      closeProof();
    }, 900);

  } catch (error) {
    message.textContent =
      error.message;

    button.disabled = false;

    button.textContent =
      'SUBMIT PROOF';
  }
}

/* =========================
   IMAGE COMPRESSION
========================= */

function compressImage(file) {
  return new Promise((resolve, reject) => {

    const reader = new FileReader();

    reader.onerror = () => {
      reject(
        new Error('Could not read screenshot')
      );
    };

    reader.onload = () => {

      const image = new Image();

      image.onerror = () => {
        reject(
          new Error('Could not process screenshot')
        );
      };

      image.onload = () => {

        const maxWidth = 1400;
        const maxHeight = 1400;

        let width = image.width;
        let height = image.height;

        if (
          width > maxWidth ||
          height > maxHeight
        ) {
          const ratio = Math.min(
            maxWidth / width,
            maxHeight / height
          );

          width = Math.round(
            width * ratio
          );

          height = Math.round(
            height * ratio
          );
        }

        const canvas =
          document.createElement('canvas');

        canvas.width = width;
        canvas.height = height;

        const context =
          canvas.getContext('2d');

        context.drawImage(
          image,
          0,
          0,
          width,
          height
        );

        /*
          JPEG quality 0.75 gives a much
          smaller proof image while keeping
          screenshots readable.
        */

        const result =
          canvas.toDataURL(
            'image/jpeg',
            0.75
          );

        resolve(result);
      };

      image.src =
        reader.result;
    };

    reader.readAsDataURL(file);
  });
}

/* =========================
   CLOSE PROOF
========================= */

function closeProof() {
  const modal =
    $('#proofModal');

  if (modal) {
    modal.style.display =
      'none';
  }
}

/* =========================
   PROOF MODAL STYLES
========================= */

function addProofStyles() {
  if ($('#proofStyles')) return;

  const style =
    document.createElement('style');

  style.id =
    'proofStyles';

  style.textContent = `
    #proofModal {
      position: fixed;
      inset: 0;
      z-index: 99999;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 18px;
    }

    .proof-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(0,0,0,.78);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 18px;
    }

    .proof-box {
      position: relative;
      width: min(100%, 430px);
      max-height: 90vh;
      overflow-y: auto;
      background: #0d1912;
      border: 1px solid #284333;
      border-radius: 18px;
      padding: 20px;
      box-shadow: 0 20px 70px rgba(0,0,0,.5);
    }

    .proof-box h2 {
      margin-top: 0;
    }

    .proof-box p {
      color: #aebbb2;
      line-height: 1.5;
    }

    .proof-close {
      position: absolute;
      right: 12px;
      top: 10px;
      width: 36px;
      height: 36px;
      border: 0;
      border-radius: 50%;
      background: #17251c;
      color: #fff;
      font-size: 24px;
      cursor: pointer;
    }

    .proof-upload {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100px;
      border: 1px dashed #3c6249;
      border-radius: 14px;
      cursor: pointer;
      text-align: center;
      padding: 20px;
      color: #dce8df;
      margin-top: 15px;
    }

    .proof-upload:hover {
      border-color: #5d8b68;
    }

    .task-status {
      display: block;
      margin-top: 10px;
      color: #aebbb2;
    }

    .rejected-status {
      color: #ff9b9b;
    }

    button:disabled {
      opacity: .6;
      cursor: not-allowed;
    }
  `;

  document.head.appendChild(style);
}

/* =========================
   HISTORY
========================= */

async function history() {
  try {
    const data =
      await api('/api/transactions');

    const container =
      $('#historyList');

    if (!container) return;

    container.innerHTML =
      data.transactions
        .map(transaction => {

          const positive = [
            'task_reward',
            'referral_bonus'
          ].includes(
            transaction.type
          );

          return `
            <div class="row">

              <span>
                <b>
                  ${esc(
                    transaction.note ||
                    transaction.type
                  )}
                </b>

                <small>
                  ${esc(
                    transaction.created_at
                  )}
                </small>
              </span>

              <b class="${positive ? 'plus' : 'minus'}">
                ${positive ? '+' : '-'}
                ${Number(
                  transaction.amount
                ).toFixed(2)}
                ${esc(
                  transaction.currency
                )}
              </b>

            </div>
          `;
        })
        .join('') ||
      '<div>No transactions yet.</div>';

  } catch (error) {
    toast(error.message);
  }
}

/* =========================
   REFRESH
========================= */

async function refresh() {
  const data =
    await api('/api/me');

  S.user =
    data.user;

  render();
}

/* =========================
   PROFILE
========================= */

async function save(event) {
  event.preventDefault();

  try {

    const data =
      await api('/api/profile', {
        method: 'PATCH',

        body: JSON.stringify({
          email:
            $('#email')?.value.trim() || '',

          paymentAddress:
            $('#address')?.value.trim() || ''
        })
      });

    S.user =
      data.user;

    render();

    toast('Profile saved');

  } catch (error) {
    toast(error.message);
  }
}

/* =========================
   EMAIL VERIFY
========================= */

async function verify() {
  try {

    await api(
      '/api/email/verify-demo',
      {
        method: 'POST',
        body: '{}'
      }
    );

    await refresh();

    toast(
      'Email verified in demo mode'
    );

  } catch (
