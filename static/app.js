(() => {
  let raw = null;

  const state = {
    month: '',
    week: '',
    status: '',
    profile: '',
    search: '',
    view: 'dashboardView',
    overrides: {},
    notices: [],
    history: { summary: [], details: [] },
    historyDate: '',
    session: null,
    pendingStatus: null,
    bound: false
  };

  const colors = {
    ok: '#24865a',
    bad: '#b94141',
    warn: '#c78a22',
    off: '#667783',
    blue: '#366f9f',
    violet: '#6f5aa7'
  };

  const statusOptions = ['Disponível', 'Parado', 'Indisponível', 'Em manutenção', 'Desmobilizada'];
  const $ = (id) => document.getElementById(id);

  function normalizeStatus(value) {
    const map = {
      'DisponÃ­vel': 'Disponível',
      'IndisponÃ­vel': 'Indisponível',
      'Em manutenÃ§Ã£o': 'Em manutenção'
    };
    return map[value] || value || '';
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    }[char]));
  }

  function numberBR(value, digits = 0) {
    return new Intl.NumberFormat('pt-BR', {
      maximumFractionDigits: digits,
      minimumFractionDigits: digits
    }).format(value || 0);
  }

  function pctBR(value) {
    return `${numberBR((value || 0) * 100, 1)}%`;
  }

  function todayIso() {
    const date = new Date();
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 10);
  }

  function formatDateBR(value) {
    if (!value) return '';
    const [year, month, day] = String(value).split('-');
    return year && month && day ? `${day}/${month}/${year}` : value;
  }

  function canEdit() {
    return Boolean(state.session?.canEdit);
  }

  function setAuthUi() {
    $('authScreen').classList.toggle('hidden', Boolean(state.session));
    $('appShell').classList.toggle('locked', !state.session);
    if (!state.session) return;

    $('userBadge').textContent = `${state.session.name}${canEdit() ? ' | edição' : ' | leitura'}`;
    document.querySelectorAll('.editor-only').forEach(element => {
      element.style.display = canEdit() ? '' : 'none';
    });
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      cache: 'no-store',
      credentials: 'same-origin',
      ...options,
      headers: {
        ...(options.headers || {})
      }
    });
    if (response.status === 401) {
      state.session = null;
      setAuthUi();
      throw new Error('Sessão expirada');
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || 'Falha na operação');
    }
    return payload;
  }

  async function loadSession() {
    const payload = await api('/api/session').catch(() => ({ user: null }));
    state.session = payload.user;
    setAuthUi();
    return state.session;
  }

  async function login(username, password) {
    const payload = await api('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    state.session = payload.user;
    setAuthUi();
    await startApp();
  }

  async function logout() {
    await api('/api/logout', { method: 'POST' }).catch(() => null);
    window.location.reload();
  }

  function normalizeDataRows() {
    raw.base = (raw.base || []).map(row => ({
      ...row,
      status: normalizeStatus(row.status),
      motivo: normalizeStatus(row.motivo)
    }));
    raw.current = (raw.current || []).map(row => ({
      ...row,
      status: normalizeStatus(row.status)
    }));
  }

  async function loadData() {
    const payload = await api('/api/data');
    raw = payload.data;
    if (!raw || !raw.meta) throw new Error('Base de dados não encontrada.');
    normalizeDataRows();
  }

  async function loadOverrides() {
    const payload = await api(`/api/overrides?date=${encodeURIComponent(raw.meta.ultimaDataBaseIso)}`);
    state.overrides = payload.overrides || {};
  }

  async function persistOverride(placa, status, meta) {
    const payload = await api('/api/overrides', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: raw.meta.ultimaDataBaseIso,
        placa,
        status,
        osNumber: meta.osNumber,
        noOsObservation: meta.noOsObservation
      })
    });
    state.overrides = payload.overrides || state.overrides;
  }

  function applyOverride(row) {
    const override = state.overrides[row.placa];
    if (!override || !override.status) {
      return { ...row, sourceStatus: row.status, osNumber: '', statusObservation: '' };
    }
    return {
      ...row,
      sourceStatus: row.status,
      status: normalizeStatus(override.status),
      ajusteManual: true,
      osNumber: override.osNumber || '',
      statusObservation: override.noOsObservation || ''
    };
  }

  async function loadNotices() {
    const payload = await api(`/api/notices?date=${encodeURIComponent(raw.meta.ultimaDataBaseIso)}`);
    state.notices = payload.notices || [];
  }

  async function persistNotice(placa, text) {
    if (!canEdit()) return;
    const clean = String(text || '').trim();
    if (!placa || !clean) return;
    const payload = await api('/api/notices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: raw.meta.ultimaDataBaseIso, placa, text: clean })
    });
    state.notices = payload.notices || state.notices;
  }

  async function deleteNotice(id) {
    if (!canEdit()) return;
    const payload = await api(`/api/notices?date=${encodeURIComponent(raw.meta.ultimaDataBaseIso)}&id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.notices = payload.notices || [];
  }

  async function loadHistory() {
    const payload = await api('/api/history');
    state.history = {
      summary: payload.summary || [],
      details: payload.details || []
    };
    if (!state.historyDate && state.history.summary.length) {
      state.historyDate = state.history.summary[state.history.summary.length - 1].date;
    }
  }

  async function saveDailySnapshot() {
    if (!canEdit()) return;
    const date = $('dailyDate').value || todayIso();
    const rows = raw.current.map(applyOverride).map(row => ({
      placa: row.placa,
      perfil: row.perfil,
      status: row.status,
      motorista: row.motorista,
      observacao: row.observacao,
      osNumber: row.osNumber || '',
      statusObservation: row.statusObservation || ''
    }));
    const payload = await api('/api/daily-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, rows })
    });
    state.history = {
      summary: payload.summary || [],
      details: payload.details || []
    };
    state.historyDate = date;
    renderHistory();
    $('timestamp').textContent = `Dia ${formatDateBR(date)} atualizado no histórico`;
  }

  function statusClass(status) {
    const clean = normalizeStatus(status);
    if (clean === 'Disponível') return 'ok';
    if (clean === 'Parado') return 'warn';
    if (clean === 'Em manutenção') return 'maint';
    if (clean === 'Desmobilizada') return 'off';
    return 'bad';
  }

  function statusColor(status) {
    const type = statusClass(status);
    return type === 'ok' ? colors.ok : type === 'warn' ? colors.warn : type === 'maint' ? colors.violet : type === 'off' ? colors.off : colors.bad;
  }

  function boardBucket(row) {
    const status = normalizeStatus(row.status);
    if (status === 'Disponível') return 'available';
    if (status === 'Parado') return 'stopped';
    if (status === 'Em manutenção') return 'maintenance';
    return 'unavailable';
  }

  function bucketMeta(key) {
    return {
      available: { title: 'Disponíveis', badge: 'Disponível', tone: 'ok' },
      stopped: { title: 'Paradas', badge: 'Parado', tone: 'warn' },
      maintenance: { title: 'Em manutenção', badge: 'Manutenção', tone: 'maint' },
      unavailable: { title: 'Indisponíveis', badge: 'Indisponível', tone: 'bad' }
    }[key];
  }

  function truckSvg() {
    return `<svg class="truck-icon" viewBox="0 0 28 20" aria-hidden="true"><path d="M2 13h3l2-6h11l4 6h4v3h-3a3 3 0 0 1-6 0H11a3 3 0 0 1-6 0H2v-3Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="8" cy="16" r="1.7" fill="currentColor"/><circle cx="20" cy="16" r="1.7" fill="currentColor"/></svg>`;
  }

  function evidenceText(row) {
    if (row.osNumber) return `OS ${escapeHtml(row.osNumber)}`;
    if (row.statusObservation) return `Sem OS: ${escapeHtml(row.statusObservation)}`;
    return '-';
  }

  function matchesFilters(row) {
    const haystack = `${row.placa} ${row.perfil} ${row.motorista} ${row.observacao} ${row.motivo}`.toLowerCase();
    return (!state.month || row.mes === state.month)
      && (!state.week || String(row.semanaMes) === state.week)
      && (!state.status || normalizeStatus(row.status) === state.status)
      && (!state.profile || row.perfil === state.profile)
      && (!state.search || haystack.includes(state.search.toLowerCase()));
  }

  function matchesCurrentFilters(row) {
    const haystack = `${row.placa} ${row.perfil} ${row.motorista} ${row.observacao}`.toLowerCase();
    return (!state.status || normalizeStatus(row.status) === state.status)
      && (!state.profile || row.perfil === state.profile)
      && (!state.search || haystack.includes(state.search.toLowerCase()));
  }

  function filteredBase() {
    return raw.base.filter(matchesFilters);
  }

  function activeRows(rows) {
    return rows.filter(row => row.ativo === 1);
  }

  function summarizeRows(rows) {
    const active = activeRows(rows);
    const diasAtivos = active.reduce((sum, row) => sum + row.ativo, 0);
    const disponiveis = active.reduce((sum, row) => sum + row.disponivel, 0);
    const indisponiveis = active.reduce((sum, row) => sum + row.indisponivel, 0);
    const horas = active.reduce((sum, row) => sum + row.horasIndisp, 0);
    return {
      diasAtivos,
      disponiveis,
      indisponiveis,
      horas,
      disponibilidade: diasAtivos ? disponiveis / diasAtivos : 0
    };
  }

  function groupBy(rows, keyFn) {
    const map = new Map();
    rows.forEach(row => {
      const key = keyFn(row);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    });
    return map;
  }

  function populateFilters() {
    $('statusFilter').innerHTML = '<option value="">Todos</option>' + statusOptions.map(status => `<option value="${status}">${status}</option>`).join('');
    const months = [...new Map(raw.base.map(row => [row.mes, row.mesLabel])).entries()]
      .sort((a, b) => a[0].localeCompare(b[0]));
    $('monthFilter').innerHTML = '<option value="">Todos</option>' + months.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');

    const profiles = [...new Set(raw.base.map(row => row.perfil).filter(Boolean))].sort();
    $('profileFilter').innerHTML = '<option value="">Todos</option>' + profiles.map(profile => `<option value="${escapeHtml(profile)}">${escapeHtml(profile)}</option>`).join('');
    updateWeekOptions();
  }

  function updateWeekOptions() {
    const rows = state.month ? raw.base.filter(row => row.mes === state.month) : raw.base;
    const weeks = [...new Map(rows.map(row => [row.semanaMes, row.semanaLabel])).entries()]
      .filter(([value]) => value)
      .sort((a, b) => Number(a[0]) - Number(b[0]));
    const current = state.week;
    $('weekFilter').innerHTML = '<option value="">Todas</option>' + weeks.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
    if (weeks.some(([value]) => String(value) === current)) {
      $('weekFilter').value = current;
    } else {
      state.week = '';
      $('weekFilter').value = '';
    }
  }

  function currentRows() {
    return raw.current.map(applyOverride).filter(row => matchesCurrentFilters(row)).sort((a, b) => {
      const rank = { 'Indisponível': 0, 'Em manutenção': 1, 'Parado': 2, 'Disponível': 3, 'Desmobilizada': 4 };
      return (rank[normalizeStatus(a.status)] ?? 9) - (rank[normalizeStatus(b.status)] ?? 9)
        || String(a.perfil || '').localeCompare(String(b.perfil || ''))
        || String(a.placa || '').localeCompare(String(b.placa || ''));
    });
  }

  function updateKpis(rows) {
    const summary = summarizeRows(rows);
    const current = currentRows();
    const currentAvailable = current.filter(row => normalizeStatus(row.status) === 'Disponível').length;
    const currentUnavailable = current.filter(row => !['Disponível', 'Parado'].includes(normalizeStatus(row.status))).length;
    $('kpiDisponibilidade').textContent = pctBR(summary.disponibilidade);
    $('kpiDisponibilidadeSub').textContent = `${numberBR(summary.diasAtivos)} dias-veículo considerados`;
    $('kpiAtivos').textContent = numberBR(current.length);
    $('kpiAtivosSub').textContent = `Base ${raw.meta.ultimaDataBase}`;
    $('kpiDisponiveis').textContent = numberBR(currentAvailable);
    $('kpiIndisp').textContent = numberBR(currentUnavailable);
    $('kpiIndispSub').textContent = 'Na última data da base';
    $('kpiHoras').textContent = numberBR(summary.horas);
  }

  function weeklyRows(rows) {
    const grouped = groupBy(activeRows(rows), row => `${row.mes}|${row.mesLabel}|${row.semanaMes}|${row.semanaLabel}`);
    return [...grouped.entries()].map(([key, values]) => {
      const [mes, mesLabel, semanaMes, semanaLabel] = key.split('|');
      const sum = summarizeRows(values);
      return {
        mes,
        mesLabel,
        semanaMes: Number(semanaMes),
        semanaLabel,
        label: `${mesLabel} ${semanaLabel}`,
        disponibilidade: sum.disponibilidade,
        diasIndisponiveis: sum.indisponiveis,
        horasIndisp: sum.horas
      };
    }).sort((a, b) => a.mes.localeCompare(b.mes) || a.semanaMes - b.semanaMes);
  }

  function monthlyRows(rows) {
    const grouped = groupBy(activeRows(rows), row => `${row.mes}|${row.mesLabel}`);
    return [...grouped.entries()].map(([key, values]) => {
      const [mes, mesLabel] = key.split('|');
      const sum = summarizeRows(values);
      return { mes, mesLabel, ...sum };
    }).sort((a, b) => a.mes.localeCompare(b.mes));
  }

  function paretoRows(rows) {
    const grouped = groupBy(activeRows(rows), row => row.placa);
    return [...grouped.entries()].map(([placa, values]) => {
      const sum = summarizeRows(values);
      const profile = values.find(row => row.perfil)?.perfil || '';
      const reasons = {};
      values.filter(row => row.indisponivel).forEach(row => {
        const reason = row.motivo || row.status || 'Sem motivo';
        reasons[reason] = (reasons[reason] || 0) + 1;
      });
      const mainReason = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
      return { placa, perfil: profile, motivoPrincipal: mainReason, ...sum };
    }).sort((a, b) => (b.horas - a.horas) || (b.indisponiveis - a.indisponiveis));
  }

  function drawTrend(rows) {
    const data = weeklyRows(rows);
    $('trendSubtitle').textContent = data.length ? `${data.length} semanas no filtro` : 'Sem dados';
    const svg = $('trendChart');
    const w = 900, h = 280, pad = { left: 46, right: 18, top: 22, bottom: 48 };
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.innerHTML = '';
    if (!data.length) {
      svg.innerHTML = `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" fill="#667783">Sem dados para o filtro</text>`;
      return;
    }

    const minY = Math.max(0.75, Math.min(...data.map(d => d.disponibilidade)) - 0.04);
    const maxY = 1;
    const x = i => pad.left + (data.length === 1 ? 0 : i * (w - pad.left - pad.right) / (data.length - 1));
    const y = v => pad.top + (maxY - v) * (h - pad.top - pad.bottom) / (maxY - minY || 1);
    const axis = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    for (let i = 0; i <= 4; i++) {
      const value = minY + (maxY - minY) * i / 4;
      const yy = y(value);
      axis.insertAdjacentHTML('beforeend', `<line x1="${pad.left}" y1="${yy}" x2="${w - pad.right}" y2="${yy}" stroke="#d9e3e8"/><text x="${pad.left - 8}" y="${yy + 4}" text-anchor="end" font-size="11" fill="#667783">${pctBR(value)}</text>`);
    }
    svg.appendChild(axis);

    const path = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(d.disponibilidade).toFixed(1)}`).join(' ');
    svg.insertAdjacentHTML('beforeend', `<path d="${path}" fill="none" stroke="#1f6f64" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`);
    data.forEach((d, i) => {
      const showLabel = data.length <= 12 || i % Math.ceil(data.length / 10) === 0 || i === data.length - 1;
      svg.insertAdjacentHTML('beforeend', `<circle cx="${x(i)}" cy="${y(d.disponibilidade)}" r="5" fill="#fff" stroke="#1f6f64" stroke-width="3"><title>${d.label}: ${pctBR(d.disponibilidade)}</title></circle>`);
      if (showLabel) {
        svg.insertAdjacentHTML('beforeend', `<text x="${x(i)}" y="${h - 24}" text-anchor="middle" font-size="10" fill="#667783">${d.semanaLabel}</text><text x="${x(i)}" y="${h - 10}" text-anchor="middle" font-size="10" fill="#667783">${d.mesLabel}</text>`);
      }
    });
  }

  function drawDonut() {
    const current = currentRows();
    const counts = current.reduce((acc, row) => {
      const status = normalizeStatus(row.status);
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});
    const entries = Object.entries(counts).filter(([, count]) => count > 0);
    const total = entries.reduce((sum, [, count]) => sum + count, 0);
    $('statusSubtitle').textContent = `${total} veículos na visão atual`;
    const svg = $('donutChart');
    svg.innerHTML = '';
    if (!total) {
      svg.innerHTML = '<text x="80" y="82" text-anchor="middle" fill="#667783">Sem dados</text>';
      $('statusLegend').innerHTML = '';
      return;
    }
    const cx = 80, cy = 80, r = 56, circumference = 2 * Math.PI * r;
    let offset = 0;
    entries.forEach(([status, count]) => {
      const ratio = count / total;
      const dash = ratio * circumference;
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', cx);
      circle.setAttribute('cy', cy);
      circle.setAttribute('r', r);
      circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke', statusColor(status));
      circle.setAttribute('stroke-width', '24');
      circle.setAttribute('stroke-dasharray', `${dash} ${circumference - dash}`);
      circle.setAttribute('stroke-dashoffset', `${-offset}`);
      circle.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
      circle.innerHTML = `<title>${status}: ${count}</title>`;
      svg.appendChild(circle);
      offset += dash;
    });
    svg.insertAdjacentHTML('beforeend', `<circle cx="${cx}" cy="${cy}" r="38" fill="#fff"/><text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="24" font-weight="800" fill="#20313b">${total}</text><text x="${cx}" y="${cy + 17}" text-anchor="middle" font-size="11" fill="#667783">veículos</text>`);
    $('statusLegend').innerHTML = entries.map(([status, count]) => `<div class="legend-item"><span class="dot" style="background:${statusColor(status)}"></span><span>${status}</span><strong>${count}</strong></div>`).join('');
  }

  function drawPareto(rows) {
    const data = paretoRows(rows).filter(row => row.horas > 0).slice(0, 10);
    const max = Math.max(...data.map(row => row.horas), 1);
    $('paretoSubtitle').textContent = data.length ? `Top ${data.length}` : 'Sem indisponibilidade';
    $('paretoBars').innerHTML = data.length ? data.map(row => {
      const width = Math.max(3, row.horas / max * 100);
      return `<div class="bar-row">
        <div class="bar-label"><strong>${escapeHtml(row.placa)}</strong><span>${escapeHtml(row.perfil || row.motivoPrincipal || '')}</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
        <div class="bar-value">${numberBR(row.horas)}h</div>
      </div>`;
    }).join('') : '<div class="empty">Sem horas indisponíveis no filtro</div>';

    const offenders = data.slice(0, 5);
    $('offenderList').innerHTML = offenders.length ? offenders.map(row => `<div class="mini-row"><div><strong>${escapeHtml(row.placa)}</strong><br><span>${escapeHtml(row.motivoPrincipal || row.perfil)}</span></div><strong>${numberBR(row.horas)}h</strong></div>`).join('') : '<div class="empty">Sem ofensores no filtro</div>';
  }

  function renderMonthly(rows) {
    const data = monthlyRows(rows);
    $('monthlyBody').innerHTML = data.length ? data.map(row => `<tr>
      <td>${escapeHtml(row.mesLabel)}</td>
      <td>${numberBR(row.diasAtivos)}</td>
      <td>${numberBR(row.disponiveis)}</td>
      <td>${numberBR(row.indisponiveis)}</td>
      <td>${numberBR(row.horas)}</td>
      <td><strong>${pctBR(row.disponibilidade)}</strong></td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty">Sem dados para o filtro</td></tr>';
  }

  function renderCurrentTable() {
    const rows = currentRows();
    $('tableSubtitle').textContent = `${rows.length} veículos`;
    $('currentBody').innerHTML = rows.length ? rows.map(row => {
      const obs = [row.observacao || '', evidenceText(row) !== '-' ? evidenceText(row) : ''].filter(Boolean).join(' | ');
      return `<tr>
        <td><span class="plate">${truckSvg()}${escapeHtml(row.placa)}</span></td>
        <td>${escapeHtml(row.perfil || '-')}</td>
        <td><span class="pill ${statusClass(row.status)}">${escapeHtml(normalizeStatus(row.status))}</span></td>
        <td>${escapeHtml(row.motorista || '-')}</td>
        <td>${obs ? obs : '-'}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="5" class="empty">Sem veículos no filtro</td></tr>';
  }

  function renderBoard() {
    const rows = currentRows();
    const groups = {
      available: rows.filter(row => boardBucket(row) === 'available'),
      stopped: rows.filter(row => boardBucket(row) === 'stopped'),
      maintenance: rows.filter(row => boardBucket(row) === 'maintenance'),
      unavailable: rows.filter(row => boardBucket(row) === 'unavailable')
    };

    $('fleetBoard').innerHTML = ['available', 'stopped', 'maintenance', 'unavailable'].map(key => {
      const meta = bucketMeta(key);
      const items = groups[key];
      const tool = key === 'maintenance' ? `<span class="tool-orbit" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M14.5 4.5 19.5 9.5 17.4 11.6 15.9 10.1 8.3 17.7a2.2 2.2 0 0 1-3.1 0l-.9-.9a2.2 2.2 0 0 1 0-3.1l7.6-7.6-1.5-1.5 2.1-2.1Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
        </svg>
      </span>` : '';
      const cards = items.length ? items.map(row => {
        const noticeCount = state.notices.filter(item => item.placa === row.placa).length;
        const actions = canEdit() ? `<div class="status-actions" data-placa="${escapeHtml(row.placa)}">
          <button class="status-action ${normalizeStatus(row.status) === 'Disponível' ? 'active ok' : ''}" type="button" data-status="Disponível" title="Marcar disponível">Disp.</button>
          <button class="status-action ${normalizeStatus(row.status) === 'Parado' ? 'active warn' : ''}" type="button" data-status="Parado" title="Marcar parado no dia">Parado</button>
          <button class="status-action ${normalizeStatus(row.status) === 'Em manutenção' ? 'active maint' : ''}" type="button" data-status="Em manutenção" title="Marcar em manutenção">Manut.</button>
          <button class="status-action ${!['Disponível', 'Parado', 'Em manutenção'].includes(normalizeStatus(row.status)) ? 'active bad' : ''}" type="button" data-status="Indisponível" title="Marcar indisponível">Indisp.</button>
        </div>` : '<div class="readonly-note">Somente leitura</div>';
        return `<article class="vehicle-card">
          <div class="vehicle-main">
            <strong title="${escapeHtml(row.placa)}">${escapeHtml(row.placa)}</strong>
            <span>${escapeHtml(row.perfil || '-')}</span>
          </div>
          ${noticeCount ? `<div class="notice-chip">${noticeCount} aviso</div>` : ''}
          ${evidenceText(row) !== '-' ? `<div class="notice-chip">${evidenceText(row)}</div>` : ''}
          ${actions}
        </article>`;
      }).join('') : '<div class="board-empty">Nenhum veículo neste grupo</div>';

      return `<div class="board-section">
        <div class="board-title">
          <span class="pill ${meta.tone}">${meta.badge}</span>
          ${tool}
          <h2>${meta.title}</h2>
          <span class="total">Total: ${items.length}</span>
        </div>
        <div class="board-box ${meta.tone}">
          <p class="board-subtitle">F. Fixa (${items.length})</p>
          <div class="vehicle-grid">${cards}</div>
        </div>
      </div>`;
    }).join('');
  }

  function populateNoticePlates() {
    const rows = raw.current.map(applyOverride).sort((a, b) => a.placa.localeCompare(b.placa));
    $('noticePlate').innerHTML = rows.map(row => `<option value="${escapeHtml(row.placa)}">${escapeHtml(row.placa)} - ${escapeHtml(row.perfil || '-')}</option>`).join('');
  }

  function renderNotices() {
    $('noticeSubtitle').textContent = canEdit()
      ? `${state.notices.length} aviso${state.notices.length === 1 ? '' : 's'}`
      : `${state.notices.length} aviso${state.notices.length === 1 ? '' : 's'} | somente leitura`;
    $('noticeList').innerHTML = state.notices.length ? state.notices.map(item => `<article class="notice-item">
      <strong>${escapeHtml(item.placa)}</strong>
      <span>${escapeHtml(item.text)}</span>
      ${canEdit() ? `<button class="notice-delete" type="button" data-id="${escapeHtml(item.id)}" title="Excluir aviso">×</button>` : ''}
    </article>`).join('') : '<div class="empty">Sem avisos cadastrados</div>';
  }

  function renderHistory() {
    const summary = state.history.summary || [];
    const details = state.history.details || [];
    const selected = state.historyDate || summary.at(-1)?.date || '';
    state.historyDate = selected;

    $('historySubtitle').textContent = `${summary.length} dias no histórico`;
    $('historyDate').innerHTML = summary.slice().reverse().map(row => `<option value="${row.date}">${row.dateLabel}</option>`).join('');
    $('historyDate').value = selected;

    $('historySummaryBody').innerHTML = summary.slice().reverse().map(row => `<tr>
      <td>${escapeHtml(row.dateLabel)}</td>
      <td>${numberBR(row.total)}</td>
      <td>${numberBR(row.available)}</td>
      <td>${numberBR(row.stopped)}</td>
      <td>${numberBR(row.maintenance)}</td>
      <td>${numberBR(row.unavailable)}</td>
      <td><strong>${pctBR(row.availability)}</strong></td>
      <td>${escapeHtml(row.source)}</td>
    </tr>`).join('');

    const dayRows = details.filter(row => row.date === selected);
    $('historyDetailSubtitle').textContent = selected ? `${formatDateBR(selected)} | ${dayRows.length} veículos` : '--';
    $('historyDetailBody').innerHTML = dayRows.length ? dayRows.map(row => `<tr>
      <td><span class="plate">${truckSvg()}${escapeHtml(row.placa)}</span></td>
      <td>${escapeHtml(row.perfil || '-')}</td>
      <td><span class="pill ${statusClass(row.status)}">${escapeHtml(normalizeStatus(row.status))}</span></td>
      <td>${escapeHtml(row.motorista || '-')}</td>
      <td>${evidenceText(row)}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="empty">Sem dados para o dia selecionado</td></tr>';
  }

  function render() {
    const rows = filteredBase();
    updateKpis(rows);
    drawTrend(rows);
    drawDonut(rows);
    drawPareto(rows);
    renderMonthly(rows);
    renderCurrentTable();
    populateNoticePlates();
    renderNotices();
    renderBoard();
    renderHistory();
  }

  function openStatusModal(placa, status) {
    if (!canEdit()) return;
    const current = state.overrides[placa] || {};
    state.pendingStatus = { placa, status };
    $('statusModalSubtitle').textContent = `${placa} | ${status}`;
    $('statusOsInput').value = current.osNumber || '';
    $('statusObsInput').value = current.noOsObservation || '';
    $('statusModalError').textContent = '';
    $('statusModal').hidden = false;
    setTimeout(() => $('statusOsInput').focus(), 0);
  }

  function closeStatusModal() {
    state.pendingStatus = null;
    $('statusModal').hidden = true;
  }

  async function confirmStatusModal() {
    if (!state.pendingStatus) return;
    const osNumber = $('statusOsInput').value.trim();
    const noOsObservation = $('statusObsInput').value.trim();
    if (!osNumber && !noOsObservation) {
      $('statusModalError').textContent = 'Informe a OS ou uma observação quando não houver OS.';
      return;
    }
    try {
      await persistOverride(state.pendingStatus.placa, state.pendingStatus.status, { osNumber, noOsObservation });
      closeStatusModal();
      render();
    } catch (error) {
      $('statusModalError').textContent = error.message;
    }
  }

  function bindEvents() {
    if (state.bound) return;
    state.bound = true;

    $('loginForm').addEventListener('submit', async event => {
      event.preventDefault();
      $('authError').textContent = '';
      try {
        await login($('authUser').value, $('authPassword').value);
      } catch (error) {
        $('authError').textContent = error.message;
      }
    });

    document.querySelectorAll('.tab-btn').forEach(button => {
      button.addEventListener('click', () => {
        state.view = button.dataset.view;
        document.querySelectorAll('.tab-btn').forEach(item => item.classList.toggle('active', item === button));
        document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === state.view));
      });
    });

    $('fleetBoard').addEventListener('click', event => {
      const button = event.target.closest('.status-action');
      if (!button) return;
      const placa = button.closest('.status-actions')?.dataset.placa;
      const status = button.dataset.status;
      if (!placa || !status) return;
      openStatusModal(placa, status);
    });

    $('statusCancel').addEventListener('click', closeStatusModal);
    $('statusConfirm').addEventListener('click', confirmStatusModal);
    $('statusModal').addEventListener('click', event => {
      if (event.target === $('statusModal')) closeStatusModal();
    });

    $('noticeSave').addEventListener('click', async () => {
      await persistNotice($('noticePlate').value, $('noticeText').value);
      $('noticeText').value = '';
      render();
    });
    $('noticeText').addEventListener('keydown', async event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      await persistNotice($('noticePlate').value, $('noticeText').value);
      $('noticeText').value = '';
      render();
    });
    $('noticeList').addEventListener('click', async event => {
      const button = event.target.closest('.notice-delete');
      if (!button) return;
      await deleteNotice(button.dataset.id);
      render();
    });

    $('dailyUpdateBtn').addEventListener('click', async () => {
      try {
        await saveDailySnapshot();
      } catch (error) {
        alert(error.message);
      }
    });
    $('historyDate').addEventListener('change', event => {
      state.historyDate = event.target.value;
      renderHistory();
    });

    $('monthFilter').addEventListener('change', event => {
      state.month = event.target.value;
      updateWeekOptions();
      render();
    });
    $('weekFilter').addEventListener('change', event => {
      state.week = event.target.value;
      render();
    });
    $('statusFilter').addEventListener('change', event => {
      state.status = event.target.value;
      render();
    });
    $('profileFilter').addEventListener('change', event => {
      state.profile = event.target.value;
      render();
    });
    $('searchFilter').addEventListener('input', event => {
      state.search = event.target.value;
      render();
    });
    $('resetBtn').addEventListener('click', () => {
      state.month = '';
      state.week = '';
      state.status = '';
      state.profile = '';
      state.search = '';
      $('monthFilter').value = '';
      $('statusFilter').value = '';
      $('profileFilter').value = '';
      $('searchFilter').value = '';
      updateWeekOptions();
      render();
    });
    $('logoutBtn').addEventListener('click', logout);
    $('printBtn').addEventListener('click', () => window.print());
  }

  async function startApp() {
    try {
      await loadData();
      $('dailyDate').value = todayIso();
      $('timestamp').textContent = `Base: ${raw.meta.ultimaDataBase} | Gerado: ${raw.meta.geradoEm}`;
      await loadOverrides();
      await loadNotices();
      await loadHistory();
      populateFilters();
      bindEvents();
      setAuthUi();
      render();
    } catch (error) {
      $('authError').textContent = error.message;
      state.session = null;
      setAuthUi();
    }
  }

  async function boot() {
    bindEvents();
    const session = await loadSession();
    if (session) {
      await startApp();
    }
  }

  boot();
})();
