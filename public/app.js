// ===== Element refs =====
const el = (id) => document.getElementById(id);

const authView = el('auth-view');
const appView = el('app-view');
const tabLogin = el('tab-login');
const tabRegister = el('tab-register');
const loginForm = el('login-form');
const registerForm = el('register-form');
const authError = el('auth-error');
const userNameEl = el('user-name');

const navRecord = el('nav-record');
const navHistory = el('nav-history');
const recordTab = el('record-tab');
const historyTab = el('history-tab');

const recordBtn = el('record-btn');
const recordLabel = el('record-label');
const timerEl = el('timer');
const languageSelect = el('language');
const liveBox = el('live-transcript-box');
const liveTranscriptEl = el('live-transcript');
const statusEl = el('status');
const resultsEl = el('results');
const summaryEl = el('summary');
const transcriptEl = el('transcript');
const participantListEl = el('participant-list');
const saveMeetingBtn = el('save-meeting-btn');
const savedActions = el('saved-actions');
const saveDriveBtn = el('save-drive-btn');
const driveLink = el('drive-link');
const newMeetingBtn = el('new-meeting-btn');
const titleInput = el('meeting-title');

const meetingListEl = el('meeting-list');
const meetingDetail = el('meeting-detail');

const configWarning = el('config-warning');
const browserWarning = el('browser-warning');

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

let currentUser = null;
let recognition = null;
let recording = false;
let finalTranscript = '';
let timerInterval = null;
let startTime = 0;
let lastResult = null;    // { transcript, summary, language }
let savedMeetingId = null;
let detailMeetingId = null;

el('year').textContent = new Date().getFullYear();

// ===== Startup =====
(async function init() {
  if (!SpeechRecognition) {
    browserWarning.classList.remove('hidden');
    recordBtn.disabled = true;
  }

  try {
    const res = await fetch('/api/status');
    const status = await res.json();
    const missing = [];
    if (!status.anthropicConfigured) missing.push('ANTHROPIC_API_KEY');
    if (!status.googleConfigured) missing.push('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET');
    if (missing.length) {
      configWarning.textContent = `⚠️ Not configured yet: ${missing.join(', ')}. Add them to the .env file and restart the server.`;
      configWarning.classList.remove('hidden');
    }
  } catch { /* surfaced on use */ }

  // Am I logged in?
  try {
    const res = await fetch('/api/me');
    if (res.ok) {
      const data = await res.json();
      enterApp(data.user);
    } else {
      authView.classList.remove('hidden');
    }
  } catch {
    authView.classList.remove('hidden');
  }

  if (new URLSearchParams(location.search).get('drive') === 'connected') {
    history.replaceState(null, '', '/');
    const pendingId = sessionStorage.getItem('pendingDriveMeetingId');
    sessionStorage.removeItem('pendingDriveMeetingId');
    if (pendingId) {
      showStatus('✅ Google Drive connected! Saving your meeting…', 'working');
      await saveMeetingToDrive(Number(pendingId), saveDriveBtn, driveLink);
    }
  }
})();

// ===== Auth =====
tabLogin.addEventListener('click', () => switchAuthTab('login'));
tabRegister.addEventListener('click', () => switchAuthTab('register'));

function switchAuthTab(which) {
  tabLogin.classList.toggle('active', which === 'login');
  tabRegister.classList.toggle('active', which === 'register');
  loginForm.classList.toggle('hidden', which !== 'login');
  registerForm.classList.toggle('hidden', which !== 'register');
  authError.classList.add('hidden');
}

loginForm.addEventListener('submit', (e) => submitAuth(e, '/api/login'));
registerForm.addEventListener('submit', (e) => submitAuth(e, '/api/register'));

async function submitAuth(e, endpoint) {
  e.preventDefault();
  authError.classList.add('hidden');
  const form = e.target;
  const body = Object.fromEntries(new FormData(form));
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    form.reset();
    enterApp(data.user);
  } catch (err) {
    authError.textContent = err.message;
    authError.classList.remove('hidden');
  }
}

function enterApp(user) {
  currentUser = user;
  userNameEl.textContent = `👋 ${user.name.split(' ')[0]}`;
  authView.classList.add('hidden');
  appView.classList.remove('hidden');
}

el('logout-btn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/';
});

// ===== Tab navigation =====
navRecord.addEventListener('click', () => switchTab('record'));
navHistory.addEventListener('click', () => { switchTab('history'); loadMeetings(); });

function switchTab(which) {
  navRecord.classList.toggle('active', which === 'record');
  navHistory.classList.toggle('active', which === 'history');
  recordTab.classList.toggle('hidden', which !== 'record');
  historyTab.classList.toggle('hidden', which !== 'history');
}

// ===== Recording (live speech recognition) =====
recordBtn.addEventListener('click', async () => {
  if (recording) {
    stopRecording();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    showStatus('❌ Microphone access denied. Allow microphone access in your browser and try again.', 'error');
    return;
  }

  finalTranscript = '';
  liveTranscriptEl.textContent = '';
  resultsEl.classList.add('hidden');
  savedActions.classList.add('hidden');
  savedMeetingId = null;
  hideStatus();

  const langChoice = languageSelect.value;
  recognition = new SpeechRecognition();
  recognition.lang = langChoice === 'mix' ? 'pt-PT' : langChoice;
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        finalTranscript += result[0].transcript + ' ';
      } else {
        interim += result[0].transcript;
      }
    }
    liveTranscriptEl.textContent = finalTranscript + interim;
    liveBox.scrollTop = liveBox.scrollHeight;
  };

  recognition.onerror = (event) => {
    if (event.error === 'not-allowed') {
      showStatus('❌ Microphone access denied. Allow microphone access and try again.', 'error');
      stopRecording();
    }
    // 'no-speech' and 'network' errors are transient; onend restarts
  };

  // Chrome stops recognition after silence — restart while still recording
  recognition.onend = () => {
    if (recording) {
      try { recognition.start(); } catch { /* already starting */ }
    }
  };

  recognition.start();
  recording = true;
  setRecordingUI(true);
  startTimer();
});

function stopRecording() {
  recording = false;
  if (recognition) {
    recognition.onend = null;
    recognition.stop();
  }
  stopTimer();
  setRecordingUI(false);
  liveBox.classList.add('hidden');
  summarize(finalTranscript.trim());
}

function setRecordingUI(isRecording) {
  recordBtn.classList.toggle('recording', isRecording);
  recordLabel.textContent = isRecording ? 'Stop Recording' : 'Start Recording';
  languageSelect.disabled = isRecording;
  if (isRecording) liveBox.classList.remove('hidden');
}

function startTimer() {
  startTime = Date.now();
  timerEl.textContent = '00:00';
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - startTime) / 1000);
    timerEl.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
}

function stopTimer() {
  clearInterval(timerInterval);
}

// ===== Summarize with Claude =====
async function summarize(transcript) {
  if (!transcript) {
    showStatus('❌ No speech was captured. Check that your microphone is working and try again.', 'error');
    return;
  }

  showStatus('⏳ Summarizing with Claude…', 'working');

  try {
    const res = await fetch('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript, language: languageSelect.value })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);

    lastResult = { transcript, summary: data.summary, language: languageSelect.value };
    hideStatus();
    await showResults(lastResult);
  } catch (err) {
    showStatus(`❌ ${err.message}`, 'error');
  }
}

async function showResults(data) {
  summaryEl.innerHTML = renderMarkdown(data.summary);
  transcriptEl.textContent = data.transcript;
  await loadParticipantPicker();
  resultsEl.classList.remove('hidden');
  resultsEl.scrollIntoView({ behavior: 'smooth' });
}

// ===== Participants =====
async function loadParticipantPicker() {
  participantListEl.innerHTML = '';
  try {
    const res = await fetch('/api/users');
    const data = await res.json();
    const others = data.users.filter((u) => u.id !== currentUser.id);
    if (!others.length) {
      participantListEl.innerHTML = '<p class="muted">No other users registered yet.</p>';
      return;
    }
    for (const user of others) {
      const label = document.createElement('label');
      label.className = 'participant-chip';
      label.innerHTML = `<input type="checkbox" value="${user.id}" /> ${escapeHtml(user.name)}`;
      label.querySelector('input').addEventListener('change', (e) => {
        label.classList.toggle('selected', e.target.checked);
      });
      participantListEl.appendChild(label);
    }
  } catch {
    participantListEl.innerHTML = '<p class="muted">Could not load users.</p>';
  }
}

// ===== Save meeting =====
saveMeetingBtn.addEventListener('click', async () => {
  if (!lastResult) return;
  saveMeetingBtn.disabled = true;
  showStatus('⏳ Saving meeting…', 'working');

  const participantIds = [...participantListEl.querySelectorAll('input:checked')].map((i) => Number(i.value));

  try {
    const res = await fetch('/api/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: titleInput.value.trim() || undefined,
        transcript: lastResult.transcript,
        summary: lastResult.summary,
        language: lastResult.language,
        participantIds
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);

    savedMeetingId = data.meeting.id;
    showStatus('✅ Meeting saved! It now appears in the history of everyone who participated.', 'success');
    savedActions.classList.remove('hidden');
    driveLink.classList.add('hidden');
    savedActions.scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    showStatus(`❌ ${err.message}`, 'error');
  } finally {
    saveMeetingBtn.disabled = false;
  }
});

newMeetingBtn.addEventListener('click', () => {
  resultsEl.classList.add('hidden');
  savedActions.classList.add('hidden');
  titleInput.value = '';
  lastResult = null;
  savedMeetingId = null;
  hideStatus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ===== Google Drive =====
saveDriveBtn.addEventListener('click', () => saveMeetingToDrive(savedMeetingId, saveDriveBtn, driveLink));
el('detail-drive-btn').addEventListener('click', () => saveMeetingToDrive(detailMeetingId, el('detail-drive-btn'), el('detail-drive-link')));

async function saveMeetingToDrive(meetingId, btn, linkEl) {
  if (!meetingId) return;
  btn.disabled = true;
  showStatus('⏳ Saving to Google Drive…', 'working');

  try {
    const res = await fetch(`/api/meetings/${meetingId}/drive`, { method: 'POST' });
    const data = await res.json();

    if (res.status === 401 && data.error === 'not_connected') {
      sessionStorage.setItem('pendingDriveMeetingId', String(meetingId));
      showStatus('🔑 Redirecting to Google to connect Drive…', 'working');
      location.href = '/auth/google';
      return;
    }
    if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);

    showStatus('✅ Saved to Google Drive!', 'success');
    linkEl.href = data.link;
    linkEl.classList.remove('hidden');
  } catch (err) {
    showStatus(`❌ ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ===== Meeting history =====
async function loadMeetings() {
  meetingDetail.classList.add('hidden');
  meetingListEl.classList.remove('hidden');
  meetingListEl.innerHTML = '<p class="empty-state">Loading…</p>';

  try {
    const res = await fetch('/api/meetings');
    const data = await res.json();
    if (!data.meetings.length) {
      meetingListEl.innerHTML =
        '<p class="empty-state">📭 No meetings yet.<br>Record your first meeting in the <strong>New Meeting</strong> tab!</p>';
      return;
    }

    meetingListEl.innerHTML = '';
    for (const m of data.meetings) {
      const item = document.createElement('div');
      item.className = 'meeting-item';
      const date = new Date(m.created_at).toLocaleString(undefined, {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
      });
      const people = m.participants.map((p) => p.name.split(' ')[0]).join(', ');
      const mine = m.owner_id === currentUser.id;
      item.innerHTML = `
        <div>
          <h3>${escapeHtml(m.title)}</h3>
          <div class="meta">${date} · recorded by ${mine ? 'you' : escapeHtml(m.owner_name)}${people ? ' · with ' + escapeHtml(people) : ''}</div>
        </div>
        <span class="badge">${mine ? 'Recorded by you' : 'Participant'}</span>`;
      item.addEventListener('click', () => openMeeting(m.id));
      meetingListEl.appendChild(item);
    }
  } catch {
    meetingListEl.innerHTML = '<p class="empty-state">Could not load meetings.</p>';
  }
}

async function openMeeting(id) {
  try {
    const res = await fetch(`/api/meetings/${id}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    const m = data.meeting;

    detailMeetingId = m.id;
    el('detail-title').textContent = m.title;
    const date = new Date(m.created_at).toLocaleString();
    const people = m.participants.map((p) => p.name).join(', ');
    el('detail-meta').textContent = `${date} · Recorded by ${m.owner_name}${people ? ' · Participants: ' + people : ''}`;
    el('detail-summary').innerHTML = renderMarkdown(m.summary);
    el('detail-transcript').textContent = m.transcript;

    const linkEl = el('detail-drive-link');
    if (m.drive_link) {
      linkEl.href = m.drive_link;
      linkEl.classList.remove('hidden');
    } else {
      linkEl.classList.add('hidden');
    }

    meetingListEl.classList.add('hidden');
    meetingDetail.classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch {
    showStatus('❌ Could not open this meeting.', 'error');
  }
}

el('back-to-list').addEventListener('click', loadMeetings);

// ===== Copy buttons =====
el('copy-summary').addEventListener('click', (e) => copyText(lastResult?.summary, e.target));
el('copy-transcript').addEventListener('click', (e) => copyText(lastResult?.transcript, e.target));

async function copyText(text, btn) {
  if (!text) return;
  await navigator.clipboard.writeText(text);
  const original = btn.textContent;
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = original; }, 1500);
}

// ===== Helpers =====
function showStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.className = `status ${kind}`;
}

function hideStatus() {
  statusEl.className = 'status hidden';
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Minimal Markdown renderer for summaries (headings, bullets, bold)
function renderMarkdown(md) {
  const lines = escapeHtml(md).split('\n');
  let html = '';
  let inList = false;
  for (const line of lines) {
    const bullet = line.match(/^\s*[-*]\s+(.*)/);
    if (bullet) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inline(bullet[1])}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    const heading = line.match(/^(#{1,4})\s+(.*)/);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6);
      html += `<h${level}>${inline(heading[2])}</h${level}>`;
    } else if (line.trim()) {
      html += `<p>${inline(line)}</p>`;
    }
  }
  if (inList) html += '</ul>';
  return html;

  function inline(s) {
    return s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  }
}
