// Absen.io Attendance System - Client JS Application (Flask Integrated version)

// Application State
const state = {
    currentTab: 'dashboard',
    theme: 'light',
    employees: [],
    logs: [],
    mediaStream: null,
    animationFrameId: null,
    isScanning: false,
    audioCtx: null,

    // AI Model State
    useRealFaceApi: false,
    modelsLoaded: false,
    activeDescriptor: null, // Temporary descriptor during scan/registration
    detectedFaceBox: null, // Face bounding box for drawing
    registrationDescriptors: [],
    isAdmin: false,
    csrfToken: '',
    totalEmployees: 0,
    simulationEnabled: false,
    timezoneLabel: 'WITA',

    // Active liveness.
    livenessChallenge: null,
    livenessProof: null
};

const LIVENESS_LABELS = {
    blink: {
        title: 'Pejamkan lalu buka mata',
        instruction:
            'Pejamkan kedua mata sekitar setengah detik, lalu buka kembali.'
    },

    turn_left: {
        title: 'Menoleh ke kiri',
        instruction:
            'Putar kepala ke sisi kiri yang terlihat pada layar.'
    },

    turn_right: {
        title: 'Menoleh ke kanan',
        instruction:
            'Putar kepala ke sisi kanan yang terlihat pada layar.'
    }
};

const LIVENESS_CONFIG = {
    // Mengambil lebih banyak sampel saat mata terbuka.
    calibrationFrames: 8,

    neutralFrames: 3,
    turnStableFrames: 3,
    identityThreshold: 0.48,
    turnThreshold: 0.13,
    centeredYawThreshold: 0.065,
    minimumFaceWidthRatio: 0.22,

    // Analisis dilakukan setiap siklus deteksi.
    // Nilai lama secara tidak langsung membaca setiap 4 frame.
    detectionFrameInterval: 2,

    // Mata dianggap tertutup ketika EAR turun
    // menjadi 84% dari kondisi mata terbuka.
    blinkClosedRatio: 0.84,

    // Mata dianggap terbuka kembali ketika EAR
    // kembali minimal 90%.
    blinkReopenRatio: 0.90,

    // Memastikan mata kiri dan kanan sama-sama menurun.
    blinkEyeBalanceRatio: 0.92,

    // Satu sampel tertutup sudah cukup.
    blinkMinClosedSamples: 1,

    // Batas maksimal mata tertutup.
    blinkMaxClosedMs: 1400
};

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
    }[char]));
}

function safeImageUrl(value) {
    const url = String(value || '');
    if (url.startsWith('/api/media/') || url.startsWith('data:image/')) return url;
    return '';
}

async function refreshSession() {
    const response = await fetch('/api/session', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Gagal mengambil status sesi');
    const data = await response.json();
    state.isAdmin = Boolean(data.authenticated);
    state.csrfToken = data.csrf_token || '';
    state.simulationEnabled = Boolean(data.simulation_enabled);
    state.timezoneLabel = data.timezone_label || 'WITA';
    updateSessionUI();
    return data;
}

async function apiFetch(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const headers = new Headers(options.headers || {});
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        if (!state.csrfToken) await refreshSession();
        headers.set('X-CSRF-Token', state.csrfToken);
    }
    const response = await fetch(url, {
        ...options,
        method,
        headers,
        credentials: 'same-origin'
    });
    if (response.status === 401) { state.isAdmin = false; updateSessionUI(); }
    return response;
}

let pendingAdminResolve = null;

function updateSessionUI() {
    document.body.classList.toggle('admin-authenticated', state.isAdmin);
    const label = document.getElementById('admin-session-label');
    const status = document.getElementById('admin-session-state');
    const menuTitle = document.getElementById('session-menu-title');
    const menuSubtitle = document.getElementById('session-menu-subtitle');

    if (label) label.textContent = state.isAdmin ? 'Administrator' : 'Operator';
    if (status) status.textContent = state.isAdmin ? 'Sesi aktif' : 'Login admin';
    if (menuTitle) menuTitle.textContent = state.isAdmin ? 'Administrator' : 'Operator';
    if (menuSubtitle) menuSubtitle.textContent = state.isAdmin ? 'Akses admin aktif' : 'Belum login';
}

function closeAdminLoginModal(result = false) {
    const modal = document.getElementById('admin-login-modal');
    const form = document.getElementById('admin-login-form');
    const error = document.getElementById('admin-login-error');
    if (modal) modal.classList.remove('active');
    if (form) form.reset();
    if (error) error.textContent = '';
    document.body.classList.remove('modal-open');
    if (pendingAdminResolve) {
        pendingAdminResolve(result);
        pendingAdminResolve = null;
    }
}

function openAdminLoginModal() {
    if (state.isAdmin) return Promise.resolve(true);
    const modal = document.getElementById('admin-login-modal');
    const passwordInput = document.getElementById('admin-password');
    const error = document.getElementById('admin-login-error');
    if (error) error.textContent = '';
    if (modal) modal.classList.add('active');
    document.body.classList.add('modal-open');
    window.setTimeout(() => passwordInput?.focus(), 120);
    return new Promise(resolve => {
        pendingAdminResolve = resolve;
    });
}

async function submitAdminLogin(event) {
    event.preventDefault();
    const passwordInput = document.getElementById('admin-password');
    const submitButton = document.getElementById('admin-login-submit');
    const error = document.getElementById('admin-login-error');
    const password = passwordInput?.value || '';

    if (!password) {
        if (error) error.textContent = 'Password wajib diisi.';
        passwordInput?.focus();
        return;
    }

    if (submitButton) {
        submitButton.disabled = true;
        submitButton.innerHTML = '<span class="material-icons-round">sync</span> Memverifikasi...';
    }

    try {
        const response = await apiFetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        const result = await response.json();
        if (!response.ok) {
            if (error) error.textContent = result.message || 'Login admin ditolak.';
            passwordInput?.select();
            return;
        }
        state.isAdmin = true;
        state.csrfToken = result.csrf_token || state.csrfToken;
        updateSessionUI();
        showToast('Login berhasil', 'Sesi administrator sekarang aktif.', 'success');
        closeAdminLoginModal(true);
        await loadData();
        renderRecentActivities();
    } catch (errorValue) {
        console.error('Admin login error:', errorValue);
        if (error) error.textContent = 'Gagal terhubung ke server.';
    } finally {
        if (submitButton) {
            submitButton.disabled = false;
            submitButton.innerHTML = '<span class="material-icons-round">login</span> Masuk sebagai admin';
        }
    }
}

async function ensureAdminSession() {
    if (state.isAdmin) return true;
    return openAdminLoginModal();
}

async function logoutAdmin() {
    try {
        const response = await apiFetch('/api/logout', { method: 'POST' });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || 'Logout gagal.');
        state.isAdmin = false;
        state.employees = [];
        state.logs = [];
        state.csrfToken = '';
        await refreshSession();
        updateSessionUI();
        closeSessionMenu();
        if (['register', 'logs', 'admin'].includes(state.currentTab)) await switchTab('dashboard');
        renderRecentActivities();
        showToast('Sesi berakhir', 'Anda telah keluar dari akses administrator.', 'success');
    } catch (error) {
        console.error('Logout error:', error);
        showToast('Logout gagal', error.message || 'Tidak dapat mengakhiri sesi.', 'error');
    }
}

// DOM Elements
const elements = {
    tabs: document.querySelectorAll('.nav-item'),
    sections: document.querySelectorAll('.tab-content'),
    themeToggle: document.getElementById('theme-toggle'),
    themeToggleIcon: document.querySelector('#theme-toggle span'),
    liveClock: document.getElementById('live-clock'),

    // System Loader Overlay
    systemLoader: document.getElementById('system-loader'),
    loaderProgress: document.getElementById('loader-progress'),
    btnSkipLoader: document.getElementById('btn-skip-loader'),
    stepCore: document.getElementById('step-core'),
    stepDetector: document.getElementById('step-detector'),
    stepLandmarks: document.getElementById('step-landmarks'),
    stepRecognition: document.getElementById('step-recognition'),

    // Stats
    statCheckIn: document.getElementById('stat-checkin'),
    statCheckOut: document.getElementById('stat-checkout'),
    statUsers: document.getElementById('stat-users'),
    recentActivityList: document.getElementById('recent-activity-list'),

    // Registration Tab
    registerForm: document.getElementById('register-form'),
    employeeId: document.getElementById('employee-id'),
    employeeName: document.getElementById('employee-name'),
    employeeRole: document.getElementById('employee-role'),
    btnStartRegisterCamera: document.getElementById('btn-start-register-camera'),
    btnCaptureFace: document.getElementById('btn-capture-face'),
    registerVideo: document.getElementById('register-video'),
    registerCanvas: document.getElementById('register-canvas'),
    registerHudStatus: document.querySelector('#register .hud-status'),
    registerMesh: document.querySelector('#register .mesh-overlay'),

    // Scan Tab
    btnStartScan: document.getElementById('btn-start-scan'),
    scanVideo: document.getElementById('scan-video'),
    scanCanvas: document.getElementById('scan-canvas'),
    scanHudStatus: document.getElementById('scan-hud-status'),
    scanMatchResult: document.getElementById('scan-match-result'),
    scanResultCard: document.getElementById('scan-result-card'),
    attendanceModes: document.getElementsByName('attendance-mode'),
    scanEmployeeId: document.getElementById('scan-employee-id'),

    scanLivenessPanel: document.getElementById(
        'scan-liveness-panel'
    ),

    scanLivenessTitle: document.getElementById(
        'scan-liveness-title'
    ),

    scanLivenessInstruction: document.getElementById(
        'scan-liveness-instruction'
    ),

    scanLivenessProgress: document.getElementById(
        'scan-liveness-progress'
    ),

    // Logs Tab
    logsTbody: document.getElementById('logs-tbody'),
    logSearch: document.getElementById('log-search'),
    btnClearLogs: document.getElementById('btn-clear-logs'),
    btnExportCsv: document.getElementById('btn-export-csv'),

    // Modals
    successModal: document.getElementById('success-modal'),
    modalTitle: document.getElementById('modal-title'),
    modalMessage: document.getElementById('modal-message'),

    // Responsive navigation and admin session
    sidebar: document.getElementById('sidebar'),
    mobileMenu: document.getElementById('mobile-menu'),
    sidebarClose: document.getElementById('sidebar-close'),
    mobileOverlay: document.getElementById('mobile-overlay'),
    adminSessionButton: document.getElementById('admin-session-button'),
    sessionMenu: document.getElementById('session-menu'),
    adminLoginForm: document.getElementById('admin-login-form'),
    adminLoginModal: document.getElementById('admin-login-modal'),
    passwordToggle: document.getElementById('password-toggle'),
    toastRegion: document.getElementById('toast-region')
};

// Initialize Application
document.addEventListener('DOMContentLoaded', async () => {
    initClock();
    initTheme();
    setupEventListeners();
    await refreshSession();
    await loadData();
    renderRecentActivities();
    updateSessionUI();
    updateTodayLabel();

    // Initialize Face-API AI models
    initFaceApi();
});

// Face-API Initialization (AI Loader Sequence)
async function initFaceApi() {
    // Load from local static assets served by Flask
    const MODEL_URL = '/static/models/';

    // Timer to offer fallback/skip loader if connection is slow/offline (5 seconds timeout)
    const fallbackTimer = setTimeout(() => {
        if (elements.btnSkipLoader) {
            elements.btnSkipLoader.textContent = state.simulationEnabled
                ? 'Gunakan Mode Simulasi Development'
                : 'Lanjutkan Tanpa Pemindaian AI';
            elements.btnSkipLoader.style.display = 'block';
        }
    }, 5000);

    try {
        // Step 1: Check Library availability
        updateStepStatus(elements.stepCore, 'active', 'Memuat TensorFlow Core...');
        await sleep(400);

        if (typeof faceapi === 'undefined') {
            throw new Error("faceapi library not loaded from CDN");
        }
        updateStepStatus(elements.stepCore, 'done', 'TensorFlow Core Loaded');
        elements.loaderProgress.style.width = '25%';

        // Step 2: Load Tiny Face Detector
        updateStepStatus(elements.stepDetector, 'active', 'Memuat Pendeteksi Wajah...');
        await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
        updateStepStatus(elements.stepDetector, 'done', 'Tiny Face Detector Loaded');
        elements.loaderProgress.style.width = '50%';

        // Step 3: Load Landmarks Model
        updateStepStatus(elements.stepLandmarks, 'active', 'Memuat Titik Landmark Wajah...');
        await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
        updateStepStatus(elements.stepLandmarks, 'done', 'Landmarks 68 Model Loaded');
        elements.loaderProgress.style.width = '75%';

        // Step 4: Load Face Recognition Model
        updateStepStatus(elements.stepRecognition, 'active', 'Memuat Pengenal Identitas...');
        await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
        updateStepStatus(elements.stepRecognition, 'done', 'Face Recognition Loaded');
        elements.loaderProgress.style.width = '100%';

        clearTimeout(fallbackTimer);
        await sleep(500); // Visual lock on 100% progress

        state.useRealFaceApi = true;
        state.modelsLoaded = true;

        // Hide loader overlay
        elements.systemLoader.classList.add('fade-out');
        document.querySelector('.sidebar .status-dot').className = 'status-dot online';
        document.querySelector('.sidebar .system-status').textContent = 'Sistem AI Aktif';

        console.log("Face-API models successfully initialized locally from Flask server.");

    } catch (error) {
        console.error("AI Initialization failed:", error);
        clearTimeout(fallbackTimer);
        handleLoaderError();
    }
}

function updateStepStatus(element, status, text) {
    if (!element) return;
    const icon = element.querySelector('.material-icons-round');
    const label = element.querySelector('span:last-child');

    if (label) label.textContent = text;

    element.className = `status-step ${status}`;
    if (status === 'active') {
        if (icon) {
            icon.textContent = 'sync';
            icon.style.animation = 'rotateHub 1.5s linear infinite';
        }
    } else if (status === 'done') {
        if (icon) {
            icon.textContent = 'check_circle';
            icon.style.animation = 'none';
        }
    } else if (status === 'failed') {
        if (icon) {
            icon.textContent = 'error';
            icon.style.animation = 'none';
        }
    }
}

function handleLoaderError() {
    updateStepStatus(elements.stepCore, 'failed', 'Gagal memuat sistem AI');
    updateStepStatus(elements.stepDetector, 'failed', 'Model wajah tidak tersedia');

    const message = elements.systemLoader.querySelector('.loader-copy');
    if (message) {
        message.textContent = state.simulationEnabled
            ? 'Model AI gagal dimuat. Mode simulasi development tersedia.'
            : 'Model AI gagal dimuat. Presensi wajah dinonaktifkan demi keamanan. Periksa koneksi lalu muat ulang halaman.';
    }

    if (elements.btnSkipLoader) {
        elements.btnSkipLoader.textContent = state.simulationEnabled
            ? 'Gunakan Mode Simulasi Development'
            : 'Lanjutkan Tanpa Pemindaian AI';
        elements.btnSkipLoader.style.display = 'block';
    }
}

// Simulation is available only when the server explicitly enables development mode.
if (elements.btnSkipLoader) {
    elements.btnSkipLoader.addEventListener('click', () => {
        state.useRealFaceApi = false;
        state.modelsLoaded = false;
        elements.systemLoader.classList.add('fade-out');
        document.querySelector('.sidebar .status-dot').className = 'status-dot warning';
        document.querySelector('.sidebar .system-status').textContent = state.simulationEnabled
            ? 'Mode Simulasi Development'
            : 'AI Tidak Aktif';
    });
}

// Sound Synthesizer (Web Audio API)
function playSound(type) {
    try {
        if (!state.audioCtx) {
            state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }

        const ctx = state.audioCtx;
        if (ctx.state === 'suspended') {
            ctx.resume();
        }

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.connect(gain);
        gain.connect(ctx.destination);

        const now = ctx.currentTime;

        if (type === 'beep') {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(800, now);
            gain.gain.setValueAtTime(0.1, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
            osc.start(now);
            osc.stop(now + 0.15);
        } else if (type === 'success') {
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(600, now);
            osc.frequency.exponentialRampToValueAtTime(1200, now + 0.2);
            gain.gain.setValueAtTime(0.15, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
            osc.start(now);
            osc.stop(now + 0.35);
        } else if (type === 'scan') {
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(120, now);
            osc.frequency.linearRampToValueAtTime(450, now + 0.3);
            gain.gain.setValueAtTime(0.03, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
            osc.start(now);
            osc.stop(now + 0.3);
        } else if (type === 'error') {
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(200, now);
            osc.frequency.setValueAtTime(130, now + 0.08);
            gain.gain.setValueAtTime(0.15, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.25);
            osc.start(now);
            osc.stop(now + 0.25);
        }
    } catch (e) {
        console.warn("Audio Context error:", e);
    }
}

// Clock Setup
function initClock() {
    const updateClock = () => {
        const now = new Date();
        if (elements.liveClock) elements.liveClock.textContent = now.toLocaleTimeString('id-ID', { hour12: false });
    };
    updateClock();
    setInterval(updateClock, 1000);
}

// Theme Setup
function initTheme() {
    const savedTheme = localStorage.getItem('theme');
    const preferredTheme = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    setTheme(savedTheme || preferredTheme);
}

function setTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    const isDark = theme === 'dark';
    if (elements.themeToggleIcon) elements.themeToggleIcon.textContent = isDark ? 'light_mode' : 'dark_mode';
    if (elements.themeToggle) elements.themeToggle.setAttribute('aria-label', isDark ? 'Gunakan tema terang' : 'Gunakan tema gelap');
}

// Navigation & Tab Switching
async function switchTab(tabId) {
    const protectedTabs = new Set(['register', 'logs', 'admin']);
    if (protectedTabs.has(tabId) && !(await ensureAdminSession())) {
        return;
    }

    if (state.mediaStream) {
        stopCamera();
    }

    elements.tabs.forEach(tab => {
        if (tab.getAttribute('data-tab') === tabId) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });

    const titleMap = {
        'dashboard': { title: 'Dashboard Presensi', subtitle: 'Ringkasan aktivitas absensi hari ini' },
        'register': { title: 'Daftar Biometrik Wajah', subtitle: 'Rekam identitas biometrik karyawan secara aman' },
        'scan': { title: 'Scan Face ID', subtitle: 'Verifikasi kehadiran melalui kamera secara real-time' },
        'logs': { title: 'Riwayat Kehadiran', subtitle: 'Tinjau dan ekspor catatan kehadiran karyawan' },
        'admin': { title: 'Admin Panel', subtitle: 'Kelola jadwal, akun karyawan, dan recycle bin' }
    };

    if (titleMap[tabId]) {
        document.getElementById('page-title').textContent = titleMap[tabId].title;
        document.getElementById('page-subtitle').textContent = titleMap[tabId].subtitle;
        const breadcrumb = document.getElementById('breadcrumb-current');
        if (breadcrumb) breadcrumb.textContent = titleMap[tabId].title.replace(' Presensi', '');
    }
    closeMobileSidebar();
    closeSessionMenu();

    elements.sections.forEach(section => {
        if (section.id === tabId) {
            section.classList.add('active');
        } else {
            section.classList.remove('active');
        }
    });

    state.currentTab = tabId;

    if (tabId === 'logs') {
        await loadData();
        renderLogs();
    } else if (tabId === 'dashboard') {
        await loadData();
        renderRecentActivities();
    } else if (tabId === 'scan') {
        resetScanTab();
    } else if (tabId === 'register') {
        resetRegisterTab();
    } else if (tabId === 'admin') {
        await loadAdminData();
    }
}

// Event Listeners
function setupEventListeners() {
    elements.tabs.forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.getAttribute('data-tab')));
    });

    document.querySelectorAll('[data-go-tab]').forEach(button => {
        button.addEventListener('click', () => switchTab(button.dataset.goTab));
    });

    elements.themeToggle?.addEventListener('click', () => {
        setTheme(state.theme === 'light' ? 'dark' : 'light');
    });

    elements.btnStartRegisterCamera?.addEventListener('click', startRegisterCamera);
    elements.btnCaptureFace?.addEventListener('click', captureRegisterFace);
    elements.btnStartScan?.addEventListener('click', startScanCamera);
    elements.logSearch?.addEventListener('input', filterLogs);
    elements.btnClearLogs?.addEventListener('click', clearLogs);
    elements.btnExportCsv?.addEventListener('click', exportLogsToCsv);
    document.getElementById('btn-view-all-logs')?.addEventListener('click', () => switchTab('logs'));
    document.getElementById('btn-quick-scan')?.addEventListener('click', () => switchTab('scan'));
    document.getElementById('btn-quick-register')?.addEventListener('click', () => switchTab('register'));
    document.getElementById('btn-save-settings')?.addEventListener('click', saveSettings);
    document.getElementById('btn-close-modal')?.addEventListener('click', closeModal);

    elements.mobileMenu?.addEventListener('click', openMobileSidebar);
    elements.sidebarClose?.addEventListener('click', closeMobileSidebar);
    elements.mobileOverlay?.addEventListener('click', closeMobileSidebar);

    elements.adminSessionButton?.addEventListener('click', event => {
        event.stopPropagation();
        toggleSessionMenu();
    });
    document.getElementById('session-login-action')?.addEventListener('click', () => {
        closeSessionMenu();
        openAdminLoginModal();
    });
    document.getElementById('session-logout-action')?.addEventListener('click', logoutAdmin);
    elements.adminLoginForm?.addEventListener('submit', submitAdminLogin);
    elements.passwordToggle?.addEventListener('click', togglePasswordVisibility);

    document.querySelectorAll('[data-close-modal="success"]').forEach(item => item.addEventListener('click', closeModal));
    document.querySelectorAll('[data-close-modal="admin-login"]').forEach(item => item.addEventListener('click', () => closeAdminLoginModal(false)));

    document.addEventListener('click', event => {
        if (!event.target.closest('#session-menu') && !event.target.closest('#admin-session-button')) closeSessionMenu();
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            closeSessionMenu();
            closeMobileSidebar();
            if (elements.adminLoginModal?.classList.contains('active')) closeAdminLoginModal(false);
            if (elements.successModal?.classList.contains('active')) closeModal();
        }
    });
}


function updateTodayLabel() {
    const label = document.getElementById('today-label');
    if (!label) return;
    const formatted = new Intl.DateTimeFormat('id-ID', {
        weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
    }).format(new Date());
    const text = label.querySelector('span:last-child');
    if (text) text.textContent = formatted;
}

function openMobileSidebar() {
    document.body.classList.add('sidebar-open');
}

function closeMobileSidebar() {
    document.body.classList.remove('sidebar-open');
}

function toggleSessionMenu() {
    elements.sessionMenu?.classList.toggle('open');
    elements.sessionMenu?.setAttribute('aria-hidden', elements.sessionMenu.classList.contains('open') ? 'false' : 'true');
}

function closeSessionMenu() {
    elements.sessionMenu?.classList.remove('open');
    elements.sessionMenu?.setAttribute('aria-hidden', 'true');
}

function togglePasswordVisibility() {
    const input = document.getElementById('admin-password');
    const icon = elements.passwordToggle?.querySelector('.material-icons-round');
    if (!input) return;
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    if (icon) icon.textContent = reveal ? 'visibility_off' : 'visibility';
    elements.passwordToggle?.setAttribute('aria-label', reveal ? 'Sembunyikan password' : 'Tampilkan password');
}

function showToast(title, message, type = 'info', duration = 4200) {
    const region = elements.toastRegion || document.getElementById('toast-region');
    if (!region) return;
    const iconMap = { success: 'check_circle', error: 'error', warning: 'warning', info: 'info' };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <span class="toast-icon"><span class="material-icons-round">${iconMap[type] || iconMap.info}</span></span>
        <span class="toast-copy"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(message)}</p></span>
        <button class="toast-close" type="button" aria-label="Tutup notifikasi"><span class="material-icons-round">close</span></button>
    `;
    const remove = () => toast.remove();
    toast.querySelector('.toast-close')?.addEventListener('click', remove);
    region.appendChild(toast);
    window.setTimeout(remove, duration);
}

// Flask API Fetch Data Handlers
async function loadData() {
    try {
        const statsRes = await apiFetch('/api/stats');
        const stats = await statsRes.json();
        if (!statsRes.ok) throw new Error(stats.message || 'Gagal memuat statistik');

        state.totalEmployees = Number(stats.total_employees || 0);
        elements.statUsers.textContent = state.totalEmployees;
        elements.statCheckIn.textContent = stats.today_checkins || 0;
        elements.statCheckOut.textContent = stats.today_checkouts || 0;

        if (state.isAdmin) {
            const [empRes, logsRes] = await Promise.all([
                apiFetch('/api/employees'),
                apiFetch('/api/logs')
            ]);
            if (empRes.status === 401 || logsRes.status === 401) {
                state.isAdmin = false;
                state.employees = [];
                state.logs = [];
                updateSessionUI();
            } else {
                if (empRes.ok) state.employees = await empRes.json();
                if (logsRes.ok) state.logs = await logsRes.json();
            }
        } else {
            state.employees = [];
            state.logs = [];
        }
    } catch (error) {
        console.error('Gagal mengambil data dari Flask API:', error);
    }
}

// Camera Operations
async function startCamera(videoElement) {
    if (state.mediaStream) {
        stopCamera();
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 640 },
                height: { ideal: 480 },
                facingMode: "user"
            },
            audio: false
        });

        state.mediaStream = stream;
        videoElement.srcObject = stream;

        return new Promise((resolve) => {
            const finish = async () => {
                try {
                    await videoElement.play();
                    resolve(true);

                } catch (playError) {
                    console.error(
                        'Video playback failed:',
                        playError
                    );

                    resolve(false);
                }
            };

            if (videoElement.readyState >= 1) {
                finish();
            } else {
                videoElement.onloadedmetadata =
                    finish;
            }
        });
    } catch (error) {
        console.error("Camera access failed:", error);
        showToast('Kamera tidak dapat diakses', 'Pastikan izin kamera telah diberikan pada browser.', 'error');
        return false;
    }
}

function stopCamera() {
    if (state.animationFrameId) {
        cancelAnimationFrame(state.animationFrameId);
        state.animationFrameId = null;
    }

    if (state.mediaStream) {
        state.mediaStream.getTracks().forEach(track => track.stop());
        state.mediaStream = null;
    }

    elements.registerVideo.srcObject = null;
    elements.scanVideo.srcObject = null;
    state.isScanning = false;
    state.activeDescriptor = null;
    state.detectedFaceBox = null;
}

// Registration Panel Logic
function resetRegisterTab() {
    elements.registerForm.reset();
    elements.btnCaptureFace.classList.add('disabled');
    elements.btnCaptureFace.disabled = true;
    elements.registerHudStatus.textContent = "Kamera Belum Terhubung";
    elements.registerHudStatus.style.backgroundColor = "";
    elements.registerHudStatus.style.color = "";
    state.registrationDescriptors = [];

    const canvas = elements.registerCanvas;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const progressRing = document.querySelector('.progress-ring__circle');
    if (progressRing) progressRing.style.strokeDashoffset = 691;
    const progressText = document.getElementById('register-progress-text');
    if (progressText) progressText.style.display = 'none';
    const laser = document.getElementById('register-laser');
    if (laser) laser.style.display = 'none';
}

async function startRegisterCamera() {
    if (!state.useRealFaceApi) {
        showToast('Model AI belum aktif', 'Registrasi wajah belum dapat dilakukan. Muat ulang halaman setelah model tersedia.', 'warning');
        return;
    }
    if (!elements.employeeId.value || !elements.employeeName.value || !elements.employeeRole.value) {
        showToast('Data belum lengkap', 'Lengkapi ID, nama, dan jabatan karyawan terlebih dahulu.', 'warning');
        return;
    }

    const id = elements.employeeId.value.trim().toUpperCase();
    const exists = state.employees.some(emp => emp.id === id);
    if (exists) {
        showToast('ID sudah terdaftar', `Karyawan dengan ID ${id} sudah tersedia. Gunakan ID lain.`, 'warning');
        return;
    }

    const success = await startCamera(elements.registerVideo);
    if (success) {
        elements.registerHudStatus.textContent = "Mengkalibrasi Kamera...";
        elements.registerHudStatus.style.backgroundColor = "rgba(0, 229, 255, 0.2)";
        elements.registerHudStatus.style.color = "var(--secondary)";

        elements.registerCanvas.width = elements.registerVideo.videoWidth;
        elements.registerCanvas.height = elements.registerVideo.videoHeight;

        animateRegisterCanvas();
    }
}

function animateRegisterCanvas() {
    const canvas = elements.registerCanvas;
    const ctx = canvas.getContext('2d');
    const video = elements.registerVideo;

    let frameCounter = 0;
    let registerProgress = 0;
    let phase = 0; // 0:Center, 1:Left, 2:Right, 3:Up, 4:Down
    let isCapturing = false;

    const progressRing = document.querySelector('.progress-ring__circle');
    const progressText = document.getElementById('register-progress-text');
    const laser = document.getElementById('register-laser');

    progressText.style.display = 'block';
    laser.style.display = 'block';

    const circumference = 691;

    const phaseMessages = [
        "Tatap lurus ke depan",
        "Perlahan tengok ke Kiri",
        "Perlahan tengok ke Kanan",
        "Perlahan tengok ke Atas",
        "Perlahan tengok ke Bawah"
    ];

    function setProgress(percent, msg) {
        const offset = circumference - (percent / 100) * circumference;
        progressRing.style.strokeDashoffset = offset;
        progressText.textContent = `${msg} ... ${Math.floor(percent)}%`;
    }

    setProgress(0, phaseMessages[0]);

    async function draw() {
        if (!state.mediaStream || isCapturing) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        frameCounter++;

        if (state.useRealFaceApi && frameCounter % 4 === 0) {
            try {
                const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 }))
                    .withFaceLandmarks()
                    .withFaceDescriptor();

                if (detection) {
                    state.activeDescriptor = detection.descriptor;
                    state.detectedFaceBox = detection.detection.box;

                    const landmarks = detection.landmarks.positions;
                    const noseTip = landmarks[30];
                    const jawLeft = landmarks[0];
                    const jawRight = landmarks[16];
                    const leftEye = landmarks[36];
                    const rightEye = landmarks[45];
                    const jawBottom = landmarks[8];

                    const distLeft = noseTip.x - jawLeft.x;
                    const distRight = jawRight.x - noseTip.x;
                    const yawRatio = distLeft / (distLeft + distRight + 0.001);

                    const eyeCenterY = (leftEye.y + rightEye.y) / 2;
                    const distEyeNose = noseTip.y - eyeCenterY;
                    const distNoseChin = jawBottom.y - noseTip.y;
                    const pitchRatio = distEyeNose / (distEyeNose + distNoseChin + 0.001);

                    let targetMet = false;

                    if (phase === 0) {
                        if (yawRatio > 0.4 && yawRatio < 0.6 && pitchRatio > 0.35 && pitchRatio < 0.55) targetMet = true;
                    } else if (phase === 1) { // Left
                        if (yawRatio < 0.45) targetMet = true;
                    } else if (phase === 2) { // Right
                        if (yawRatio > 0.55) targetMet = true;
                    } else if (phase === 3) { // Up
                        if (pitchRatio < 0.42) targetMet = true;
                    } else if (phase === 4) { // Down
                        if (pitchRatio > 0.52) targetMet = true;
                    }

                    if (targetMet) {
                        registerProgress += 2.5;
                        elements.registerHudStatus.style.backgroundColor = "rgba(0, 255, 136, 0.25)";
                        elements.registerHudStatus.style.color = "var(--primary)";

                        const savePhaseDescriptor = () => {
                            state.registrationDescriptors[phase] = Array.from(detection.descriptor);
                        };

                        if (phase === 0 && registerProgress >= 20) { savePhaseDescriptor(); phase = 1; }
                        else if (phase === 1 && registerProgress >= 40) { savePhaseDescriptor(); phase = 2; }
                        else if (phase === 2 && registerProgress >= 60) { savePhaseDescriptor(); phase = 3; }
                        else if (phase === 3 && registerProgress >= 80) { savePhaseDescriptor(); phase = 4; }
                        else if (phase === 4 && registerProgress >= 100) {
                            savePhaseDescriptor();
                            registerProgress = 100;
                            setProgress(100, "Wajah Lengkap");
                            elements.registerHudStatus.textContent = "Pemindaian Selesai!";
                            isCapturing = true;
                            setTimeout(() => captureRegisterFace(), 500);
                            return;
                        }
                    } else {
                        elements.registerHudStatus.style.backgroundColor = "rgba(245, 158, 11, 0.2)";
                        elements.registerHudStatus.style.color = "var(--warning)";
                    }

                    elements.registerHudStatus.textContent = phaseMessages[phase];

                } else {
                    state.activeDescriptor = null;
                    state.detectedFaceBox = null;

                    elements.registerHudStatus.textContent = "Arahkan Wajah ke Dalam Lingkaran";
                    elements.registerHudStatus.style.backgroundColor = "rgba(239, 68, 68, 0.15)";
                    elements.registerHudStatus.style.color = "var(--danger)";
                }
                setProgress(registerProgress, phaseMessages[phase] || "Selesai");
            } catch (err) {
                console.error("Detection loop error:", err);
            }
        } else if (!state.useRealFaceApi) {
            elements.registerHudStatus.textContent = 'Model AI belum aktif';
            elements.registerHudStatus.style.backgroundColor = 'rgba(239, 68, 68, 0.15)';
            elements.registerHudStatus.style.color = 'var(--danger)';
        }

        if (state.useRealFaceApi && state.detectedFaceBox) {
            const box = state.detectedFaceBox;
            ctx.strokeStyle = 'rgba(0, 255, 136, 0.4)';
            ctx.lineWidth = 1;
            ctx.strokeRect(box.x, box.y, box.width, box.height);

            const timeFactor = Date.now() * 0.003;
            const points = [
                { x: box.x + box.width * 0.25, y: box.y + box.height * 0.35 },
                { x: box.x + box.width * 0.75, y: box.y + box.height * 0.35 },
                { x: box.x + box.width * 0.5, y: box.y + box.height * 0.55 },
                { x: box.x + box.width * 0.5, y: box.y + box.height * 0.75 }
            ];

            ctx.fillStyle = 'var(--secondary)';
            points.forEach((pt, idx) => {
                const wiggle = Math.sin(timeFactor + idx) * 1.2;
                ctx.beginPath();
                ctx.arc(pt.x, pt.y + wiggle, 2, 0, Math.PI * 2);
                ctx.fill();
            });
        }

        state.animationFrameId = requestAnimationFrame(draw);
    }

    state.animationFrameId = requestAnimationFrame(draw);
}

async function captureRegisterFace() {
    if (state.useRealFaceApi && !state.activeDescriptor) {
        playSound('error');
        showToast('Wajah tidak terdeteksi', 'Arahkan wajah ke tengah kamera dan pastikan pencahayaan cukup.', 'error');
        return;
    }

    const video = elements.registerVideo;
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');

    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const photoDataUrl = canvas.toDataURL('image/jpeg', 0.85);

    playSound('beep');

    const id = elements.employeeId.value.trim().toUpperCase();
    const name = elements.employeeName.value.trim();
    const role = elements.employeeRole.value.trim();

    const descriptorToSave = state.registrationDescriptors.filter(
        descriptor => Array.isArray(descriptor) && descriptor.length === 128
    );
    if (!state.useRealFaceApi || descriptorToSave.length < 3) {
        playSound('error');
        showToast('Data wajah belum cukup', 'Minimal tiga sudut wajah harus berhasil direkam.', 'error');
        return;
    }

    // SEND TO FLASK SERVER
    const payload = {
        id,
        name,
        role,
        photo: photoDataUrl,
        descriptor: descriptorToSave
    };

    try {
        const response = await apiFetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const result = await response.json();

        if (response.ok) {
            stopCamera();
            showModal('Registrasi Wajah Sukses', `Biometrik wajah <strong>${escapeHtml(name)}</strong> (ID: ${escapeHtml(id)}) telah diverifikasi dan disimpan ke server.`);
            resetRegisterTab();
            await loadData();
            renderRecentActivities();
        } else {
            playSound('error');
            showToast('Pendaftaran gagal', result.message || 'Data tidak dapat disimpan.', 'error');
        }
    } catch (err) {
        console.error("API register error:", err);
        showToast('Gangguan jaringan', 'Data tidak dapat disimpan ke server.', 'error');
    }
}

// Scan Tab (Attendance Verification)
function resetScanTab() {
    if (elements.scanEmployeeId) {
        elements.scanEmployeeId.value = '';
    }
    elements.scanHudStatus.textContent = "Menunggu Kamera...";
    elements.scanHudStatus.style.backgroundColor = "";
    elements.scanHudStatus.style.color = "";
    elements.scanMatchResult.style.display = "none";

    elements.scanResultCard.className = "scan-result-card empty";
    elements.scanResultCard.innerHTML = `
        <div class="result-avatar">
            <span class="material-icons-round">face</span>
        </div>
        <div class="result-details">
            <h3>Belum ada pemindaian</h3>
            <p>Data verifikasi karyawan akan ditampilkan setelah wajah berhasil diproses.</p>
        </div>
    `;
    state.isScanning = false;
    state.activeDescriptor = null;
    state.detectedFaceBox = null;
}

function updateLivenessPanel(
    actions,
    activeIndex = -1,
    mode = 'active',
    customTitle = '',
    customInstruction = ''
) {
    const panel = elements.scanLivenessPanel;

    if (!panel) return;

    panel.classList.remove(
        'is-active',
        'is-success',
        'is-error'
    );

    if (mode === 'active') {
        panel.classList.add('is-active');
    }

    if (mode === 'success') {
        panel.classList.add('is-success');
    }

    if (mode === 'error') {
        panel.classList.add('is-error');
    }

    if (customTitle) {
        elements.scanLivenessTitle.textContent = customTitle;
    }

    if (customInstruction) {
        elements.scanLivenessInstruction.textContent =
            customInstruction;
    }

    if (!Array.isArray(actions)) {
        elements.scanLivenessTitle.textContent =
            'Pemeriksaan keaslian belum dimulai';

        elements.scanLivenessInstruction.textContent =
            'Ikuti gerakan acak agar foto atau video tidak dapat digunakan.';

        elements.scanLivenessProgress.innerHTML = '';
        return;
    }

    elements.scanLivenessProgress.innerHTML = actions
        .map((_, index) => {
            const status =
                index < activeIndex
                    ? 'done'
                    : index === activeIndex
                        ? 'active'
                        : '';

            return `
                <span
                    class="liveness-step ${status}"
                    aria-hidden="true">
                </span>
            `;
        })
        .join('');
}


async function requestLivenessChallenge() {
    const controller = new AbortController();

    const timeoutId = window.setTimeout(
        () => controller.abort(),
        8000
    );

    try {
        const response = await fetch(
            '/api/liveness/challenge',
            {
                method: 'GET',
                credentials: 'same-origin',
                cache: 'no-store',

                headers: {
                    Accept: 'application/json'
                },

                signal: controller.signal
            }
        );

        const contentType =
            response.headers.get(
                'content-type'
            ) || '';

        if (
            !contentType.includes(
                'application/json'
            )
        ) {
            throw new Error(
                `Endpoint liveness tidak mengirim JSON ` +
                `(HTTP ${response.status}). ` +
                `Pastikan app.py terbaru sudah dijalankan.`
            );
        }

        const result = await response.json();

        if (!response.ok) {
            throw new Error(
                result.message ||
                `Gagal membuat tantangan ` +
                `(HTTP ${response.status}).`
            );
        }

        if (
            !result.challenge_id ||
            !Array.isArray(result.actions) ||
            result.actions.length < 2
        ) {
            throw new Error(
                'Respons tantangan liveness tidak valid.'
            );
        }

        return result;

    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(
                'Server tidak merespons endpoint ' +
                'liveness dalam 8 detik. ' +
                'Restart aplikasi Flask.'
            );
        }

        throw error;

    } finally {
        window.clearTimeout(timeoutId);
    }
}


function pointDistance(firstPoint, secondPoint) {
    return Math.hypot(
        firstPoint.x - secondPoint.x,
        firstPoint.y - secondPoint.y
    );
}


function eyeAspectRatio(points) {
    if (!Array.isArray(points) || points.length !== 6) {
        return 0;
    }

    const verticalA = pointDistance(
        points[1],
        points[5]
    );

    const verticalB = pointDistance(
        points[2],
        points[4]
    );

    const horizontal = pointDistance(
        points[0],
        points[3]
    );

    if (horizontal <= 0) {
        return 0;
    }

    return (
        verticalA + verticalB
    ) / (
            2 * horizontal
        );
}


function averagePoint(points) {
    const total = points.reduce(
        (accumulator, point) => ({
            x: accumulator.x + point.x,
            y: accumulator.y + point.y
        }),
        {
            x: 0,
            y: 0
        }
    );

    return {
        x: total.x / points.length,
        y: total.y / points.length
    };
}


function getLivenessMetrics(landmarks) {
    const positions = landmarks.positions;

    const leftEye = positions.slice(36, 42);
    const rightEye = positions.slice(42, 48);

    const leftCenter = averagePoint(leftEye);
    const rightCenter = averagePoint(rightEye);

    const eyeMidpointX =
        (leftCenter.x + rightCenter.x) / 2;

    const eyeSpan = Math.abs(
        rightCenter.x - leftCenter.x
    );

    const noseTip = positions[30];

    // Hitung mata kiri dan kanan secara terpisah.
    const leftEar = eyeAspectRatio(leftEye);
    const rightEar = eyeAspectRatio(rightEye);

    return {
        leftEar,
        rightEar,

        // Rata-rata kedua mata.
        ear: (leftEar + rightEar) / 2,

        rawYaw:
            eyeSpan > 0
                ? (noseTip.x - eyeMidpointX) / eyeSpan
                : 0
    };
}

function percentile(values, ratio = 0.75) {
    if (
        !Array.isArray(values) ||
        values.length === 0
    ) {
        return 0;
    }

    const sorted = [...values].sort(
        (a, b) => a - b
    );

    const index = Math.min(
        sorted.length - 1,
        Math.max(
            0,
            Math.round(
                (sorted.length - 1) * ratio
            )
        )
    );

    return sorted[index];
}


function descriptorDistance(first, second) {
    if (
        !first ||
        !second ||
        first.length !== second.length
    ) {
        return Infinity;
    }

    let sum = 0;

    for (
        let index = 0;
        index < first.length;
        index++
    ) {
        const difference =
            first[index] - second[index];

        sum += difference * difference;
    }

    return Math.sqrt(sum);
}


function averageDescriptors(descriptors) {
    if (
        !Array.isArray(descriptors) ||
        descriptors.length === 0
    ) {
        return null;
    }

    const output = new Float32Array(
        descriptors[0].length
    );

    descriptors.forEach(descriptor => {
        for (
            let index = 0;
            index < output.length;
            index++
        ) {
            output[index] += descriptor[index];
        }
    });

    for (
        let index = 0;
        index < output.length;
        index++
    ) {
        output[index] /= descriptors.length;
    }

    return output;
}


function isFacePositionValid(box, canvas) {
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;

    const horizontalOffset = Math.abs(
        centerX - canvas.width / 2
    ) / canvas.width;

    const verticalOffset = Math.abs(
        centerY - canvas.height / 2
    ) / canvas.height;

    return (
        box.width >=
        canvas.width *
        LIVENESS_CONFIG.minimumFaceWidthRatio
        &&
        horizontalOffset <= 0.22
        &&
        verticalOffset <= 0.25
    );
}

async function startScanCamera() {
    if (
        !state.useRealFaceApi &&
        !state.simulationEnabled
    ) {
        playSound('error');

        showToast(
            'Model AI belum aktif',
            'Muat ulang halaman setelah koneksi atau file model tersedia.',
            'warning'
        );

        return;
    }

    if (state.totalEmployees === 0) {
        playSound('error');

        showToast(
            'Belum ada profil wajah',
            'Daftarkan karyawan terlebih dahulu sebelum melakukan presensi.',
            'warning'
        );

        switchTab('register');
        return;
    }

    const success = await startCamera(
        elements.scanVideo
    );

    if (!success) {
        return;
    }

    resetScanTab();

    elements.scanHudStatus.textContent =
        'Membuat Tantangan Acak...';

    elements.scanHudStatus.style.backgroundColor =
        'rgba(0, 229, 255, 0.2)';

    elements.scanHudStatus.style.color =
        'var(--secondary)';

    try {
        state.livenessChallenge =
            await requestLivenessChallenge();
        elements.scanHudStatus.textContent =
            'KALIBRASI WAJAH...';

        elements.scanHudStatus.style.backgroundColor =
            'rgba(0, 229, 255, 0.2)';

        elements.scanHudStatus.style.color =
            'var(--secondary)';
    } catch (error) {
        stopCamera();
        playSound('error');

        updateLivenessPanel(
            null,
            -1,
            'error',
            'Tantangan gagal dibuat',
            error.message
        );

        showToast(
            'Pemeriksaan keaslian gagal',
            error.message,
            'error'
        );

        return;
    }

    elements.scanCanvas.width =
        elements.scanVideo.videoWidth;

    elements.scanCanvas.height =
        elements.scanVideo.videoHeight;

    state.isScanning = true;

    updateLivenessPanel(
        state.livenessChallenge.actions,
        0,
        'active',
        'Kalibrasi wajah',
        'Hadap lurus, buka mata, dan jangan bergerak sesaat.'
    );

    animateScanCanvas(
        state.livenessChallenge
    );
}

function animateScanCanvas(challenge) {
    const canvas = elements.scanCanvas;
    const ctx = canvas.getContext('2d');
    const video = elements.scanVideo;
    const startedAt = performance.now();

    let blinkClosedFrames = 0;
    let blinkWasClosed = false;
    let blinkClosedAt = 0;

    let waitingForNeutral = false;
    let baselineDescriptor = null;

    let neutralYaw = 0;
    let neutralEar = 0;
    let neutralLeftEar = 0;
    let neutralRightEar = 0;

    let yawAccumulator = 0;

    const earSamples = [];
    const leftEarSamples = [];
    const rightEarSamples = [];

    let bestActionScore = 0;

    const proofSteps = [];
    const verifiedDescriptors = [];

    function setInstruction(title, instruction) {
        updateLivenessPanel(
            challenge.actions,
            currentActionIndex,
            'active',
            title,
            instruction
        );

        elements.scanHudStatus.textContent =
            title.toUpperCase();

        elements.scanHudStatus.style.backgroundColor =
            'rgba(0, 229, 255, 0.2)';

        elements.scanHudStatus.style.color =
            'var(--secondary)';
    }

    function resetActionCounters() {
        stableActionFrames = 0;
        blinkClosedFrames = 0;
        blinkWasClosed = false;
        blinkClosedAt = 0;
        bestActionScore = 0;
    }

    function showCurrentAction() {
        const action =
            challenge.actions[currentActionIndex];

        const label =
            LIVENESS_LABELS[action];

        setInstruction(
            label.title,
            label.instruction
        );
    }

    function finishWithError(message) {
        state.isScanning = false;

        stopCamera();

        updateLivenessPanel(
            challenge.actions,
            currentActionIndex,
            'error',
            'Pemeriksaan keaslian gagal',
            message
        );

        failVerification(message);
    }

    function completeAction(
        action,
        score,
        descriptor
    ) {
        proofSteps.push({
            action,
            score: Number(
                Math.max(0, score).toFixed(4)
            ),
            at_ms: Math.round(
                performance.now() - startedAt
            )
        });

        verifiedDescriptors.push(
            Float32Array.from(descriptor)
        );

        playSound('success');

        bestActionScore = 0;

        const isLastAction =
            currentActionIndex >=
            challenge.actions.length - 1;

        if (isLastAction) {
            const finalDescriptor =
                averageDescriptors(
                    verifiedDescriptors
                );

            if (!finalDescriptor) {
                finishWithError(
                    'Descriptor wajah tidak dapat dibentuk setelah pemeriksaan.'
                );

                return;
            }

            state.isScanning = false;

            state.livenessProof = {
                challengeId:
                    challenge.challenge_id,

                steps:
                    proofSteps,

                durationMs:
                    Math.round(
                        performance.now() -
                        startedAt
                    )
            };

            updateLivenessPanel(
                challenge.actions,
                challenge.actions.length,
                'success',
                'Wajah hidup terverifikasi',
                'Seluruh gerakan berhasil. Memverifikasi identitas...'
            );

            elements.scanHudStatus.textContent =
                'LIVENESS BERHASIL';

            processFaceMatch(
                finalDescriptor,
                state.livenessProof
            );

            return;
        }

        waitingForNeutral = true;
        neutralFrames = 0;

        resetActionCounters();

        setInstruction(
            'Kembali hadap depan',
            'Hadap lurus kembali sebelum gerakan berikutnya.'
        );
    }

    async function draw() {
        if (
            !state.mediaStream ||
            !state.isScanning
        ) {
            return;
        }

        ctx.clearRect(
            0,
            0,
            canvas.width,
            canvas.height
        );

        frameCounter++;

        const elapsedMs =
            performance.now() - startedAt;

        const challengeLimit =
            Number(
                challenge.expires_in || 45
            ) * 1000;

        if (
            elapsedMs >
            challengeLimit - 750
        ) {
            finishWithError(
                'Waktu tantangan habis. Silakan mulai pemindaian kembali.'
            );

            return;
        }

        const faceX = canvas.width / 2;
        const faceY = canvas.height / 2;
        const radius = 110;

        ctx.strokeStyle =
            'rgba(0, 229, 255, 0.3)';

        ctx.lineWidth = 1;
        ctx.setLineDash([4, 8]);

        ctx.beginPath();
        ctx.arc(
            faceX,
            faceY,
            radius,
            0,
            Math.PI * 2
        );
        ctx.stroke();

        ctx.setLineDash([]);

        const angle =
            Date.now() * 0.002;

        ctx.strokeStyle =
            'var(--secondary)';

        ctx.lineWidth = 3;

        ctx.beginPath();
        ctx.arc(
            faceX,
            faceY,
            radius + 5,
            angle,
            angle + Math.PI / 4
        );
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(
            faceX,
            faceY,
            radius + 5,
            angle + Math.PI,
            angle + Math.PI + Math.PI / 4
        );
        ctx.stroke();

        if (
            state.useRealFaceApi &&
            frameCounter %
            LIVENESS_CONFIG.detectionFrameInterval ===
            0
        ) {
            try {
                const detections =
                    await faceapi
                        .detectAllFaces(
                            video,
                            new faceapi
                                .TinyFaceDetectorOptions({
                                    inputSize: 224,
                                    scoreThreshold: 0.55
                                })
                        )
                        .withFaceLandmarks()
                        .withFaceDescriptors();

                if (detections.length !== 1) {
                    state.activeDescriptor = null;
                    state.detectedFaceBox = null;

                    resetActionCounters();

                    elements.scanHudStatus.textContent =
                        detections.length > 1
                            ? 'HANYA SATU WAJAH'
                            : 'MENCARI WAJAH...';

                    elements.scanHudStatus
                        .style.backgroundColor =
                        'rgba(239, 68, 68, 0.15)';

                    elements.scanHudStatus
                        .style.color =
                        'var(--danger)';

                    if (detections.length > 1) {
                        updateLivenessPanel(
                            challenge.actions,
                            currentActionIndex,
                            'error',
                            'Terdeteksi lebih dari satu wajah',
                            'Pastikan hanya satu orang berada di depan kamera.'
                        );
                    }
                } else {
                    const detection =
                        detections[0];

                    const descriptor =
                        detection.descriptor;

                    const box =
                        detection.detection.box;

                    const metrics =
                        getLivenessMetrics(
                            detection.landmarks
                        );

                    state.activeDescriptor =
                        descriptor;

                    state.detectedFaceBox =
                        box;

                    if (
                        !isFacePositionValid(
                            box,
                            canvas
                        )
                    ) {
                        resetActionCounters();

                        elements.scanHudStatus
                            .textContent =
                            'POSISIKAN WAJAH DI TENGAH';

                        updateLivenessPanel(
                            challenge.actions,
                            currentActionIndex,
                            'active',
                            'Atur posisi wajah',
                            'Dekatkan dan tempatkan wajah tepat di tengah bingkai.'
                        );
                    } else if (
                        calibrationFrames <
                        LIVENESS_CONFIG
                            .calibrationFrames
                    ) {
                        yawAccumulator += metrics.rawYaw;

                        earSamples.push(metrics.ear);
                        leftEarSamples.push(metrics.leftEar);
                        rightEarSamples.push(metrics.rightEar);

                        calibrationFrames++;

                        baselineDescriptor =
                            baselineDescriptor ||
                            Float32Array.from(
                                descriptor
                            );

                        elements.scanHudStatus
                            .textContent =
                            `KALIBRASI ${calibrationFrames}/${LIVENESS_CONFIG.calibrationFrames}`;

                        if (
                            calibrationFrames ===
                            LIVENESS_CONFIG
                                .calibrationFrames
                        ) {
                            neutralYaw =
                                yawAccumulator / calibrationFrames;

                            // Mengambil nilai mata terbuka yang stabil.
                            // Kedipan ketika kalibrasi tidak merusak baseline.
                            neutralEar = percentile(
                                earSamples,
                                0.75
                            );

                            neutralLeftEar = percentile(
                                leftEarSamples,
                                0.75
                            );

                            neutralRightEar = percentile(
                                rightEarSamples,
                                0.75
                            );

                            if (
                                neutralEar <= 0.12 ||
                                neutralLeftEar <= 0.10 ||
                                neutralRightEar <= 0.10
                            ) {
                                finishWithError(
                                    'Mata tidak terbaca dengan baik. ' +
                                    'Perbaiki pencahayaan dan ulangi.'
                                );

                                return;
                            }

                            showCurrentAction();
                        }
                    } else if (
                        descriptorDistance(
                            baselineDescriptor,
                            descriptor
                        ) >
                        LIVENESS_CONFIG
                            .identityThreshold
                    ) {
                        finishWithError(
                            'Wajah berubah selama pemeriksaan. Pastikan orang yang sama tetap di depan kamera.'
                        );

                        return;
                    } else {
                        const relativeYaw =
                            metrics.rawYaw -
                            neutralYaw;

                        const eyesOpen =
                            metrics.ear >=
                            neutralEar * 0.86;

                        if (waitingForNeutral) {
                            const isCentered =
                                Math.abs(
                                    relativeYaw
                                ) <=
                                LIVENESS_CONFIG
                                    .centeredYawThreshold;

                            if (
                                isCentered &&
                                eyesOpen
                            ) {
                                neutralFrames++;
                            } else {
                                neutralFrames = 0;
                            }

                            if (
                                neutralFrames >=
                                LIVENESS_CONFIG
                                    .neutralFrames
                            ) {
                                waitingForNeutral =
                                    false;

                                currentActionIndex++;

                                resetActionCounters();
                                showCurrentAction();
                            }
                        } else {
                            const action =
                                challenge.actions[
                                currentActionIndex
                                ];

                            if (action === 'blink') {
                                if (action === 'blink') {
                                    const now = performance.now();

                                    // Bandingkan EAR saat ini dengan baseline
                                    // mata kiri dan kanan masing-masing.
                                    const leftRatio =
                                        metrics.leftEar / neutralLeftEar;

                                    const rightRatio =
                                        metrics.rightEar / neutralRightEar;

                                    const averageEyeRatio =
                                        (leftRatio + rightRatio) / 2;

                                    // Kedua mata harus mengalami penurunan.
                                    const bothEyesDropped = (
                                        leftRatio <=
                                        LIVENESS_CONFIG
                                            .blinkEyeBalanceRatio &&
                                        rightRatio <=
                                        LIVENESS_CONFIG
                                            .blinkEyeBalanceRatio
                                    );

                                    const eyesClosed = (
                                        averageEyeRatio <=
                                        LIVENESS_CONFIG
                                            .blinkClosedRatio &&
                                        bothEyesDropped
                                    );

                                    const eyesReopened = (
                                        averageEyeRatio >=
                                        LIVENESS_CONFIG
                                            .blinkReopenRatio &&
                                        leftRatio >= 0.84 &&
                                        rightRatio >= 0.84
                                    );

                                    // Tahap pertama: menunggu mata tertutup.
                                    if (!blinkWasClosed) {
                                        if (eyesClosed) {
                                            blinkClosedFrames++;

                                            bestActionScore = Math.max(
                                                bestActionScore,
                                                1 - averageEyeRatio
                                            );

                                            if (
                                                blinkClosedFrames >=
                                                LIVENESS_CONFIG
                                                    .blinkMinClosedSamples
                                            ) {
                                                blinkWasClosed = true;
                                                blinkClosedAt = now;

                                                elements.scanHudStatus
                                                    .textContent =
                                                    'MATA TERTUTUP — BUKA KEMBALI';
                                            }
                                        } else {
                                            blinkClosedFrames = 0;
                                        }

                                        // Mata terlalu lama tertutup.
                                    } else if (
                                        now - blinkClosedAt >
                                        LIVENESS_CONFIG.blinkMaxClosedMs
                                    ) {
                                        resetActionCounters();

                                        setInstruction(
                                            'Ulangi kedipan',
                                            'Pejamkan kedua mata sebentar, ' +
                                            'lalu buka kembali.'
                                        );

                                        // Tahap kedua: mata sudah terbuka kembali.
                                    } else if (eyesReopened) {
                                        completeAction(
                                            action,

                                            // Backend memerlukan skor minimal 0,15.
                                            Math.max(
                                                bestActionScore,
                                                0.16
                                            ),

                                            descriptor
                                        );
                                    }
                                }

                            } else {
                                const directionPassed =
                                    action ===
                                        'turn_left'
                                        ? relativeYaw >=
                                        LIVENESS_CONFIG
                                            .turnThreshold
                                        : relativeYaw <=
                                        -LIVENESS_CONFIG
                                            .turnThreshold;

                                if (directionPassed) {
                                    stableActionFrames++;

                                    bestActionScore =
                                        Math.max(
                                            bestActionScore,
                                            Math.abs(
                                                relativeYaw
                                            )
                                        );
                                } else {
                                    stableActionFrames = 0;
                                }

                                if (
                                    stableActionFrames >=
                                    LIVENESS_CONFIG
                                        .turnStableFrames
                                ) {
                                    completeAction(
                                        action,
                                        bestActionScore,
                                        descriptor
                                    );
                                }
                            }
                        }
                    }
                }
            } catch (error) {
                console.error(
                    'Liveness scan loop error:',
                    error
                );
            }
        } else if (
            !state.useRealFaceApi &&
            state.simulationEnabled &&
            frameCounter === 60
        ) {
            state.isScanning = false;

            processSimulatedMatch();
            return;
        }

        if (
            state.useRealFaceApi &&
            state.detectedFaceBox
        ) {
            const box =
                state.detectedFaceBox;

            ctx.strokeStyle =
                'var(--primary)';

            ctx.lineWidth = 2;

            ctx.strokeRect(
                box.x,
                box.y,
                box.width,
                box.height
            );

            ctx.fillStyle =
                'var(--primary)';

            ctx.font =
                '11px "Space Grotesk"';

            ctx.fillText(
                'LIVE CHECK',
                box.x,
                Math.max(12, box.y - 10)
            );
        }

        state.animationFrameId =
            requestAnimationFrame(draw);
    }

    state.animationFrameId =
        requestAnimationFrame(draw);
}

// POST Biometric descriptor vector to Flask for matching & logging
async function processFaceMatch(
    liveDescriptor,
    livenessProof
) {
    const video = elements.scanVideo;
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const snapshotUrl = canvas.toDataURL('image/jpeg', 0.85);

    stopCamera();

    const inputEmpId = elements.scanEmployeeId.value.trim().toUpperCase();
    let attendanceType = 'check-in';
    elements.attendanceModes.forEach(radio => {
        if (radio.checked) attendanceType = radio.value;
    });

    const payload = {
        employee_id: inputEmpId || null,

        descriptor:
            Array.from(liveDescriptor),

        snapshot_photo:
            snapshotUrl,

        type:
            attendanceType,

        simulate:
            false,

        liveness_challenge_id:
            livenessProof?.challengeId || '',

        liveness_steps:
            livenessProof?.steps || [],

        liveness_duration_ms:
            livenessProof?.durationMs || 0
    };

    try {
        const response = await apiFetch('/api/attendance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const result = await response.json();

        if (response.ok) {
            executeAttendanceSuccess(result.employee, result.similarity, snapshotUrl, result.log);
        } else {
            failVerification(result.message);
        }
    } catch (err) {
        console.error("Attendance API network error:", err);
        failVerification("Gagal memverifikasi: Terjadi kesalahan jaringan dengan server.");
    }
}

// Send mock/simulated scan trigger to Flask (so offline runs still save in SQLite database)
async function processSimulatedMatch() {
    if (!state.simulationEnabled) {
        failVerification('Mode simulasi tidak diizinkan oleh server.');
        return;
    }
    const video = elements.scanVideo;
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const snapshotUrl = canvas.toDataURL('image/jpeg', 0.85);

    stopCamera();

    const inputEmpId = elements.scanEmployeeId.value.trim().toUpperCase();
    let attendanceType = 'check-in';
    elements.attendanceModes.forEach(radio => {
        if (radio.checked) attendanceType = radio.value;
    });

    const payload = {
        employee_id: inputEmpId || null,
        snapshot_photo: snapshotUrl,
        type: attendanceType,
        simulate: true
    };

    try {
        const response = await apiFetch('/api/attendance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const result = await response.json();

        if (response.ok) {
            executeAttendanceSuccess(result.employee, result.similarity, snapshotUrl, result.log);
        } else {
            failVerification(result.message);
        }
    } catch (err) {
        console.error("Simulated Attendance API error:", err);
        failVerification("Gagal memproses absensi simulasi.");
    }
}

function executeAttendanceSuccess(employee, similarity, snapshotUrl, log) {
    playSound('success');

    elements.scanHudStatus.textContent = 'VERIFIKASI SUKSES';
    elements.scanHudStatus.style.backgroundColor = 'rgba(16, 185, 129, 0.3)';
    elements.scanHudStatus.style.color = 'var(--primary)';

    elements.scanMatchResult.textContent = `MATCH: ${employee.name} (${Number(similarity).toFixed(1)}%)`;
    elements.scanMatchResult.style.display = 'block';
    elements.scanMatchResult.style.backgroundColor = 'var(--primary)';
    elements.scanMatchResult.style.color = 'var(--text-inverse)';

    const isLate = log.is_late === 1;
    const safeType = log.type === 'check-out' ? 'check-out' : 'check-in';
    elements.scanResultCard.className = 'scan-result-card success-match';
    elements.scanResultCard.innerHTML = `
        <div class="result-avatar">
            <img src="${safeImageUrl(snapshotUrl)}" alt="Live snapshot">
        </div>
        <div class="result-details">
            <span class="badge ${safeType}">${safeType.toUpperCase()}</span>
            <span class="badge ${isLate ? 'late' : 'check-in'} result-status-badge">${escapeHtml(log.status)}</span>
            <h3>${escapeHtml(employee.name)}</h3>
            <p>${escapeHtml(employee.role)}</p>
            <div class="match-meta">
                <div class="match-meta-item">
                    <span class="meta-label">ID Karyawan</span>
                    <span class="meta-val">${escapeHtml(employee.id)}</span>
                </div>
                <div class="match-meta-item">
                    <span class="meta-label">Skor Kecocokan</span>
                    <span class="meta-val">${Number(similarity).toFixed(1)}%</span>
                </div>
            </div>
            <p class="attendance-success-time">
                Presensi terdaftar pukul ${escapeHtml(log.time)} ${escapeHtml(state.timezoneLabel)}
            </p>
        </div>
    `;

    loadData();
    speakPhrase(`Absensi ${safeType === 'check-in' ? 'masuk' : 'keluar'} berhasil. Selamat bekerja, ${String(employee.name).split(' ')[0]}.`);
}

function failVerification(reason) {
    stopCamera();
    playSound('error');

    elements.scanHudStatus.textContent = "VERIFIKASI GAGAL";
    elements.scanHudStatus.style.backgroundColor = "rgba(239, 68, 68, 0.3)";
    elements.scanHudStatus.style.color = "var(--danger)";

    elements.scanResultCard.className = "scan-result-card error-match";
    elements.scanResultCard.innerHTML = `
        <div class="result-avatar">
            <span class="material-icons-round">no_accounts</span>
        </div>
        <div class="result-details">
            <h3>Verifikasi ditolak</h3>
            <p>${escapeHtml(reason)}</p>
            <button class="btn btn-secondary btn-block retry-scan-btn" id="btn-retry-scan">
                <span class="material-icons-round">refresh</span>
                <span>Ulangi Pemindaian</span>
            </button>
        </div>
    `;
    document.getElementById('btn-retry-scan')?.addEventListener('click', startScanCamera);

    speakPhrase('Verifikasi absensi ditolak.');
}

// Speech Synthesis
function speakPhrase(phrase) {
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(phrase);
        utterance.lang = 'id-ID';
        utterance.pitch = 1.0;
        utterance.rate = 1.05;
        window.speechSynthesis.speak(utterance);
    }
}

// Dashboard Aggregates Render
function renderRecentActivities() {
    const container = elements.recentActivityList;
    container.innerHTML = '';

    if (!state.isAdmin) {
        container.innerHTML = `
            <div class="empty-state">
                <span class="material-icons-round">lock</span>
                <h3>Login admin diperlukan</h3>
                <p>Aktivitas rinci hanya dapat dilihat setelah sesi administrator aktif.</p>
            </div>
        `;
        return;
    }

    const today = new Date().toDateString();
    const todayLogs = state.logs
        .filter(log => new Date(log.timestamp).toDateString() === today)
        .slice(0, 5);

    if (todayLogs.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <span class="material-icons-round">event_available</span>
                <h3>Belum ada aktivitas</h3>
                <p>Aktivitas presensi hari ini akan tampil di sini.</p>
            </div>
        `;
        return;
    }

    todayLogs.forEach(log => {
        const item = document.createElement('div');
        item.className = 'activity-item';
        const isLate = log.is_late === 1;
        const type = log.type === 'check-out' ? 'check-out' : 'check-in';
        const badgeClass = type === 'check-in' ? (isLate ? 'late' : 'check-in') : 'check-out';
        const badgeLabel = type === 'check-in' ? (isLate ? 'Terlambat' : 'Masuk') : 'Keluar';

        item.innerHTML = `
            <div class="activity-user">
                <img src="${safeImageUrl(log.snapshot_photo)}" class="activity-avatar" alt="Foto presensi">
                <div class="user-meta">
                    <h4>${escapeHtml(log.name)}</h4>
                    <p>${escapeHtml(log.role)} • ID: ${escapeHtml(log.employee_id)}</p>
                </div>
            </div>
            <div class="activity-time-status">
                <span class="activity-time">${escapeHtml(log.time)}</span>
                <span class="badge ${badgeClass}">${badgeLabel}</span>
            </div>
        `;
        container.appendChild(item);
    });
}

// Logs Table Panel
function renderLogs(logsToRender = state.logs) {
    elements.logsTbody.innerHTML = '';

    if (logsToRender.length === 0) {
        elements.logsTbody.innerHTML = `
            <tr>
                <td colspan="7" class="table-empty-cell">
                    <div class="table-empty-state">
                        <span class="material-icons-round">search_off</span>
                        <strong>Tidak ada riwayat ditemukan</strong>
                        <small>Coba ubah kata kunci pencarian atau lakukan presensi baru.</small>
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    logsToRender.forEach(log => {
        const tr = document.createElement('tr');
        const type = log.type === 'check-out' ? 'check-out' : 'check-in';
        const statusClass = type === 'check-in'
            ? (log.is_late === 1 ? 'late' : 'check-in')
            : 'check-out';

        tr.innerHTML = `
            <td><img src="${safeImageUrl(log.snapshot_photo)}" class="log-snapshot" alt="Face snapshot"></td>
            <td>
                <div class="logs-employee-info">
                    ${escapeHtml(log.name)}
                    <span class="logs-employee-role">${escapeHtml(log.role)}</span>
                </div>
            </td>
            <td><code>${escapeHtml(log.employee_id)}</code></td>
            <td>
                <div class="logs-time">
                    ${escapeHtml(log.time)}
                    <span class="logs-date">${escapeHtml(log.date)}</span>
                </div>
            </td>
            <td><span class="badge ${type}">${type.toUpperCase()}</span></td>
            <td>
                <span class="method-label">
                    <span class="material-icons-round">verified</span>
                    ${escapeHtml(log.method)}
                </span>
            </td>
            <td><span class="badge ${statusClass}">${escapeHtml(log.status)}</span></td>
        `;
        elements.logsTbody.appendChild(tr);
    });
}

function filterLogs() {
    const query = elements.logSearch.value.trim().toLowerCase();

    if (!query) {
        renderLogs();
        return;
    }

    const filtered = state.logs.filter(log =>
        log.name.toLowerCase().includes(query) ||
        log.employee_id.toLowerCase().includes(query) ||
        log.role.toLowerCase().includes(query)
    );

    renderLogs(filtered);
}

async function clearLogs() {
    if (confirm("Apakah Anda yakin ingin menghapus semua riwayat kehadiran dari server? Data biometrik karyawan tetap aman.")) {
        try {
            const response = await apiFetch('/api/clear-logs', { method: 'POST' });
            if (response.ok) {
                await loadData();
                renderLogs();
                renderRecentActivities();
                playSound('beep');
            } else {
                showToast('Gagal menghapus riwayat', 'Server menolak permintaan penghapusan.', 'error');
            }
        } catch (e) {
            console.error("Clear logs error:", e);
            showToast('Gangguan jaringan', 'Riwayat tidak dapat dihapus.', 'error');
        }
    }
}

function exportLogsToCsv() {
    if (state.logs.length === 0) {
        showToast('Tidak ada data', 'Belum ada riwayat presensi untuk diekspor.', 'warning');
        return;
    }
    // Redirect browser to Flask's file download endpoint
    window.location.href = '/api/export-csv';
}

// Helpers
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Modals
function showModal(title, message) {
    elements.modalTitle.textContent = title;
    elements.modalMessage.innerHTML = message;
    elements.successModal.classList.add('active');
    document.body.classList.add('modal-open');
    playSound('success');
}

function closeModal() {
    elements.successModal.classList.remove('active');
    document.body.classList.remove('modal-open');
}

// --- ADMIN PANEL & RECYCLE BIN FUNCTIONS ---

async function loadAdminData() {
    try {
        if (!(await ensureAdminSession())) return;

        const [setRes, empRes, recycleRes] = await Promise.all([
            apiFetch('/api/settings'),
            apiFetch('/api/employees'),
            apiFetch('/api/employees/recycle_bin')
        ]);

        if (!setRes.ok || !empRes.ok || !recycleRes.ok) {
            throw new Error('Sesi admin berakhir atau data gagal dimuat.');
        }

        const settings = await setRes.json();
        state.employees = await empRes.json();
        const recycled = await recycleRes.json();

        document.getElementById('setting-checkin-start').value = settings.checkin_start || '07:00';
        document.getElementById('setting-checkin-end').value = settings.checkin_end || '09:00';
        document.getElementById('setting-checkout-start').value = settings.checkout_start || '17:00';
        document.getElementById('setting-checkout-end').value = settings.checkout_end || '19:00';

        renderAdminTables(state.employees, recycled);
    } catch (error) {
        console.error('Failed to load admin data:', error);
        showToast('Gagal memuat data admin', error.message || 'Silakan coba kembali.', 'error');
    }
}

async function saveSettings() {
    const payload = {
        checkin_start: document.getElementById('setting-checkin-start').value,
        checkin_end: document.getElementById('setting-checkin-end').value,
        checkout_start: document.getElementById('setting-checkout-start').value,
        checkout_end: document.getElementById('setting-checkout-end').value
    };

    try {
        const response = await apiFetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const result = await response.json();
        showToast(response.ok ? 'Jadwal tersimpan' : 'Gagal menyimpan', result.message || (response.ok ? 'Pengaturan berhasil diperbarui.' : 'Pengaturan tidak dapat disimpan.'), response.ok ? 'success' : 'error');
    } catch (error) {
        console.error('Save settings error:', error);
        showToast('Gagal menyimpan jadwal', 'Terjadi gangguan saat menghubungi server.', 'error');
    }
}

function renderAdminTables(active, recycled) {
    const activeTbody = document.getElementById('admin-active-tbody');
    const recycleTbody = document.getElementById('admin-recycle-tbody');
    if (!activeTbody || !recycleTbody) return;

    activeTbody.innerHTML = '';
    recycleTbody.innerHTML = '';

    if (active.length === 0) {
        activeTbody.innerHTML = '<tr><td colspan="4" class="table-empty-cell">Tidak ada karyawan aktif</td></tr>';
    } else {
        active.forEach(emp => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td><code>${escapeHtml(emp.id)}</code></td>
                <td>${escapeHtml(emp.name)}</td>
                <td>${escapeHtml(emp.role)}</td>
                <td>
                    <button class="btn btn-danger-ghost admin-action" data-action="soft-delete" data-id="${escapeHtml(emp.id)}">Hapus</button>
                </td>
            `;
            activeTbody.appendChild(row);
        });
    }

    if (recycled.length === 0) {
        recycleTbody.innerHTML = '<tr><td colspan="4" class="table-empty-cell">Recycle bin kosong</td></tr>';
    } else {
        recycled.forEach(emp => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td><code>${escapeHtml(emp.id)}</code></td>
                <td>${escapeHtml(emp.name)}</td>
                <td>${escapeHtml(emp.role)}</td>
                <td><div class="admin-actions">
                    <button class="btn btn-secondary admin-action" data-action="restore" data-id="${escapeHtml(emp.id)}">Pulihkan</button>
                    <button class="btn btn-danger-ghost admin-action" data-action="permanent-delete" data-id="${escapeHtml(emp.id)}">Hapus Permanen</button>
                    </div></td>
            `;
            recycleTbody.appendChild(row);
        });
    }
}

async function runAdminAction(action, id) {
    const encodedId = encodeURIComponent(id);
    let url = `/api/employees/${encodedId}`;
    let method = 'DELETE';
    let confirmation = `Pindahkan akun ${id} ke Recycle Bin?`;

    if (action === 'restore') {
        url += '/restore';
        method = 'POST';
        confirmation = `Pulihkan akun ${id} dari Recycle Bin?`;
    } else if (action === 'permanent-delete') {
        url += '/permanent';
        confirmation = `PERINGATAN: Hapus permanen akun ${id}? Data tidak dapat dikembalikan.`;
    }

    if (!confirm(confirmation)) return;

    const response = await apiFetch(url, { method });
    const result = await response.json();
    if (!response.ok) {
        showToast('Aksi admin gagal', result.message || 'Permintaan tidak dapat diproses.', 'error');
        return;
    }
    await loadAdminData();
    await loadData();
    renderRecentActivities();
}

document.addEventListener('click', event => {
    const button = event.target.closest('.admin-action');
    if (!button) return;
    runAdminAction(button.dataset.action, button.dataset.id).catch(error => {
        console.error('Admin action error:', error);
        showToast('Terjadi kesalahan', 'Aksi administrator tidak dapat diselesaikan.', 'error');
    });
});

