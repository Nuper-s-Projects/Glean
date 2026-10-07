const errorNode = document.querySelector('#admin-error');
const loginForm = document.querySelector('#admin-login');

async function request(path, method = 'GET', body) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Admin request failed.');
  return payload;
}

if (loginForm) {
  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = loginForm.querySelector('button');
    button.disabled = true;
    errorNode.textContent = '';
    const data = new FormData(loginForm);
    try {
      const response = await fetch('/api/v1/auth/signin', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: data.get('username'), password: data.get('password') }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Sign in failed.');
      window.location.reload();
    } catch (error) {
      errorNode.textContent = error.message;
      button.disabled = false;
    }
  });
}

const schoolHoursToggle = document.querySelector('#school-hours-toggle');
const offlineScreenToggle = document.querySelector('#offline-screen-toggle');
const accessStatus = document.querySelector('#access-status');

if (schoolHoursToggle && offlineScreenToggle) {
  request('/api/v1/admin/access').then(({ schoolHoursAllowed, offlineScreenEnabled }) => {
    schoolHoursToggle.checked = schoolHoursAllowed;
    offlineScreenToggle.checked = offlineScreenEnabled;
  }).catch((error) => { errorNode.textContent = error.message; });

  const saveToggle = async (toggle, field, previousValue) => {
    toggle.disabled = true;
    accessStatus.textContent = 'Saving…';
    errorNode.textContent = '';
    try {
      const settings = await request('/api/v1/admin/access', 'PATCH', { [field]: toggle.checked });
      schoolHoursToggle.checked = settings.schoolHoursAllowed;
      offlineScreenToggle.checked = settings.offlineScreenEnabled;
      accessStatus.textContent = 'Settings saved.';
    } catch (error) {
      toggle.checked = previousValue;
      errorNode.textContent = error.message;
      accessStatus.textContent = '';
    } finally {
      toggle.disabled = false;
    }
  };

  schoolHoursToggle.addEventListener('change', () => saveToggle(schoolHoursToggle, 'schoolHoursAllowed', !schoolHoursToggle.checked));
  offlineScreenToggle.addEventListener('change', () => saveToggle(offlineScreenToggle, 'offlineScreenEnabled', !offlineScreenToggle.checked));
}

const officialServerHiddenToggle = document.querySelector('#official-server-hidden-toggle');
const officialServerStatus = document.querySelector('#official-server-status');

if (officialServerHiddenToggle && officialServerStatus) {
  request('/api/v1/admin/official-server').then(({ hidden }) => {
    officialServerHiddenToggle.checked = hidden;
    officialServerStatus.textContent = hidden ? 'The official Glean server is hidden from everyone.' : 'The official Glean server is visible.';
  }).catch((error) => { errorNode.textContent = error.message; });

  officialServerHiddenToggle.addEventListener('change', async () => {
    const previous = !officialServerHiddenToggle.checked;
    officialServerHiddenToggle.disabled = true;
    officialServerStatus.textContent = 'Saving…';
    errorNode.textContent = '';
    try {
      const saved = await request('/api/v1/admin/official-server', 'PATCH', { hidden: officialServerHiddenToggle.checked });
      officialServerHiddenToggle.checked = saved.hidden;
      officialServerStatus.textContent = saved.hidden ? 'The official Glean server is hidden from everyone.' : 'The official Glean server is visible again.';
    } catch (error) {
      officialServerHiddenToggle.checked = previous;
      officialServerStatus.textContent = '';
      errorNode.textContent = error.message;
    } finally {
      officialServerHiddenToggle.disabled = false;
    }
  });
}

const announcementMessage = document.querySelector('#announcement-message');
const announcementEnabled = document.querySelector('#announcement-enabled');
const announcementSave = document.querySelector('#announcement-save');
const announcementStatus = document.querySelector('#announcement-status');

if (announcementMessage && announcementEnabled && announcementSave) {
  request('/api/v1/admin/announcement').then(({ message, enabled }) => {
    announcementMessage.value = message || '';
    announcementEnabled.checked = enabled;
  }).catch((error) => { errorNode.textContent = error.message; });

  announcementSave.addEventListener('click', async () => {
    announcementSave.disabled = true;
    announcementStatus.textContent = 'Saving…';
    errorNode.textContent = '';
    try {
      const saved = await request('/api/v1/admin/announcement', 'PATCH', {
        message: announcementMessage.value,
        enabled: announcementEnabled.checked,
      });
      announcementMessage.value = saved.message;
      announcementEnabled.checked = saved.enabled;
      announcementStatus.textContent = saved.enabled ? 'Announcement is visible to everyone.' : 'Announcement saved and hidden.';
    } catch (error) {
      errorNode.textContent = error.message;
      announcementStatus.textContent = '';
    } finally {
      announcementSave.disabled = false;
    }
  });
}

async function requestMaintenance(method = 'GET', enabled) {
  return request('/api/v1/admin/maintenance', method, method === 'PATCH' ? { enabled } : undefined);
}

const maintenanceToggle = document.querySelector('#maintenance-toggle');
const maintenanceStatus = document.querySelector('#maintenance-status');

if (maintenanceToggle && maintenanceStatus) {
  const render = (enabled) => {
    maintenanceToggle.dataset.enabled = String(enabled);
    maintenanceToggle.textContent = enabled ? 'Restore website' : 'Shut down website';
    maintenanceStatus.textContent = enabled ? 'Emergency shutdown is active.' : 'Emergency shutdown is off.';
  };

  requestMaintenance().then(({ enabled }) => render(enabled)).catch((error) => {
    errorNode.textContent = error.message;
  });

  maintenanceToggle.addEventListener('click', async () => {
    maintenanceToggle.disabled = true;
    errorNode.textContent = '';
    try {
      const { enabled } = await requestMaintenance('PATCH', maintenanceToggle.dataset.enabled !== 'true');
      render(enabled);
    } catch (error) {
      errorNode.textContent = error.message;
    } finally {
      maintenanceToggle.disabled = false;
    }
  });
}
