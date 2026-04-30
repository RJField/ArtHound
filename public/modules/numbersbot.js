import { apiFetch, $ } from './ui.js';

const messages = [];

function renderMessages() {
  const container = $('numbersbot-messages');
  container.innerHTML = '';
  for (const msg of messages) {
    const div = document.createElement('div');
    div.className = `nb-message nb-message-${msg.role}`;
    const text = document.createElement('div');
    text.className = 'nb-message-text';
    text.textContent = msg.content;
    div.appendChild(text);
    container.appendChild(div);
  }
  container.scrollTop = container.scrollHeight;
}

async function sendMessage() {
  const input = $('numbersbot-input');
  const question = input.value.trim();
  if (!question) return;

  input.value = '';
  input.disabled = true;
  $('numbersbot-send').disabled = true;

  messages.push({ role: 'user', content: question });
  renderMessages();

  const container = $('numbersbot-messages');
  const typingDiv = document.createElement('div');
  typingDiv.className = 'nb-message nb-message-assistant';
  typingDiv.innerHTML = '<div class="nb-message-text nb-typing">Thinking…</div>';
  container.appendChild(typingDiv);
  container.scrollTop = container.scrollHeight;

  try {
    const { answer } = await apiFetch('/api/numbersbot/chat', {
      method: 'POST',
      body: JSON.stringify({ messages }),
    });
    messages.push({ role: 'assistant', content: answer });
  } catch (err) {
    messages.push({ role: 'assistant', content: `Error: ${err.message}` });
  }

  renderMessages();
  input.disabled = false;
  $('numbersbot-send').disabled = false;
  input.focus();
}

function openNumbersBot() {
  $('numbersbot-overlay').classList.add('open');
  $('numbersbot-input').focus();
}

function closeNumbersBot() {
  $('numbersbot-overlay').classList.remove('open');
}

export function initNumbersBot() {
  $('numbersbot-close').addEventListener('click', closeNumbersBot);
  $('numbersbot-overlay').addEventListener('click', e => {
    if (e.target === $('numbersbot-overlay')) closeNumbersBot();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('numbersbot-overlay').classList.contains('open')) closeNumbersBot();
  });

  $('numbersbot-send').addEventListener('click', sendMessage);
  $('numbersbot-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  for (const id of ['numbersbot-btn-studio', 'numbersbot-btn-vendor']) {
    const el = $(id);
    if (el) el.addEventListener('click', openNumbersBot);
  }

  messages.push({
    role: 'assistant',
    content: "Hi! I'm NumberBot. Ask me anything about the ArtHound asset schema — fields, types, tables, and how they relate to estimation and production.",
  });
  renderMessages();
}
