const element = (tag, className, value) => { const node = document.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = String(value).slice(0, 2000); return node; };
const labels = { pending: '待确认', initiated: '连接中', connected: '已连接', skipped: '已跳过', failed: '连接失败', expired: '授权已过期', not_connected: '未连接' };

// Returns the same {card, controls} shape used by native approval cards. Secret
// fields are submitted only to the human connection-response route.
export function connectionRequestView(request, { submit } = {}) {
  const card = element('article', 'wf-conversation-pending-item'), controls = [], fields = [], targets = request?.params?.targets || [];
  card.setAttribute('aria-label', '连接授权'); card.append(element('strong', '', '连接授权'));
  const action = (text, answer) => {
    const button = element('button', 'wf-button', text); button.type = 'button'; controls.push(button);
    button.addEventListener('click', () => {
      if (button.disabled) return;
      const body = answer();
      if (body) void submit?.(body);
    });
    return button;
  };
  for (const target of targets.slice(0, 10)) {
    const row = element('div', 'wf-conversation-pending-item'), name = String(target.name || '').slice(0, 80);
    row.append(element('span', '', `${name} · ${labels[target.state] || '状态未知'}`));
    if (target.detail) row.append(element('p', '', target.detail));
    if (typeof target.connect_url === 'string') {
      try {
        const url = new URL(target.connect_url);
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
          const link = element('a', 'wf-conversation-link', '打开授权页面'); link.setAttribute('href', url.href); link.setAttribute('target', '_blank'); link.setAttribute('rel', 'noopener noreferrer'); row.append(link);
        }
      } catch {}
    }
    for (const field of (target.required_env || []).slice(0, 32)) {
      const label = element('label', 'settings-field'), input = element('input');
      input.type = field.secret ? 'password' : 'text'; input.value = field.secret ? '' : String(field.default || ''); input.autocomplete = 'off'; input.spellcheck = false;
      input.setAttribute('aria-label', field.prompt || field.name); if (field.required) input.required = true;
      label.append(element('span', '', field.prompt || field.name), input); row.append(label); controls.push(input); fields.push({ target: name, field, input });
    }
    card.append(row);
  }
  const pending = targets.filter(target => target.kind === 'mcp' && target.state === 'pending');
  if (pending.length) card.append(action('确认连接', () => {
    const answers = [];
    for (const target of pending) {
      const env = {};
      for (const { field, input } of fields.filter(row => row.target === target.name)) {
        if (field.required && !input.value.trim()) { input.reportValidity?.(); input.focus?.(); return null; }
        if (input.value) env[field.name] = input.value;
      }
      answers.push({ name: target.name, status: 'approved', ...(Object.keys(env).length ? { env } : {}) });
    }
    return { targets: answers };
  }));
  card.append(action('检查连接', () => ({ targets: [] })));
  card.append(action('取消', () => ({ targets: targets.filter(target => !['connected', 'skipped'].includes(target.state)).map(target => ({ name: target.name, status: 'skipped' })), settled_by: 'continue' })));
  return { card, controls };
}
