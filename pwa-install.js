/* ==========================================================================
   PWA INSTALLATION POPUP & UNIVERSAL APP INSTALL LOGIC
   ========================================================================== */
(function() {
  'use strict';

  let deferredPrompt = null;
  const isIos = /iphone|ipad|ipod/.test(navigator.userAgent.toLowerCase());
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || 
                       window.navigator.standalone === true;

  // If already running as an installed standalone app, don't show prompt
  if (isStandalone) {
    console.log('[PWA] Running in standalone mode');
    return;
  }

  // Check if dismissed recently (within 8 hours)
  const dismissedTime = localStorage.getItem('bpcl_pwa_dismissed');
  const now = Date.now();
  const shouldSuppressAutoPopup = dismissedTime && (now - parseInt(dismissedTime) < 8 * 60 * 60 * 1000);

  function showInstallModal() {
    const modal = document.getElementById('pwa-install-modal');
    if (!modal) return;
    
    const iosBox = document.getElementById('pwa-ios-instructions');
    const deskBox = document.getElementById('pwa-desktop-guide');
    const installBtn = document.getElementById('btn-pwa-install-action');

    if (isIos && iosBox) {
      iosBox.style.display = 'flex';
      if (deskBox) deskBox.style.display = 'none';
      if (installBtn) installBtn.style.display = 'none';
    } else {
      if (iosBox) iosBox.style.display = 'none';
      if (installBtn) installBtn.style.display = 'inline-flex';
    }

    modal.style.display = 'flex';
    setTimeout(() => {
      modal.classList.add('pwa-visible');
    }, 20);
  }

  function hideInstallModal() {
    const modal = document.getElementById('pwa-install-modal');
    if (!modal) return;
    modal.classList.remove('pwa-visible');
    setTimeout(() => {
      modal.style.display = 'none';
    }, 300);
  }

  // Capture beforeinstallprompt event (Chrome, Edge, Android)
  window.addEventListener('beforeinstallprompt', (e) => {
    // Prevent default mini-infobar
    e.preventDefault();
    deferredPrompt = e;
    console.log('[PWA] beforeinstallprompt captured');

    // Show install buttons in sidebar and mobile header
    const sideBtn = document.getElementById('btn-sidebar-install');
    if (sideBtn) sideBtn.style.display = 'flex';
    const mobBtn = document.getElementById('btn-mobile-install');
    if (mobBtn) mobBtn.style.display = 'flex';

    // Auto popup after 1.5 seconds if not recently dismissed
    if (!shouldSuppressAutoPopup) {
      setTimeout(showInstallModal, 1500);
    }
  });

  // For iOS or browsers where beforeinstallprompt doesn't fire immediately, auto-prompt on access
  window.addEventListener('load', () => {
    // Show buttons in sidebar and mobile header so manual 1-click install is always available
    const sideBtn = document.getElementById('btn-sidebar-install');
    if (sideBtn) sideBtn.style.display = 'flex';
    const mobBtn = document.getElementById('btn-mobile-install');
    if (mobBtn) mobBtn.style.display = 'flex';

    // If iOS and not standalone, show prompt after 1.8 seconds
    if (isIos && !isStandalone && !shouldSuppressAutoPopup) {
      setTimeout(showInstallModal, 1800);
    }
    
    // For general browsers (Desktop Chrome, Edge, etc.), auto popup after 2 seconds
    setTimeout(() => {
      if (!isStandalone && !shouldSuppressAutoPopup) {
        showInstallModal();
      }
    }, 2000);
  });

  // When installed successfully
  window.addEventListener('appinstalled', () => {
    console.log('[PWA] Application successfully installed!');
    deferredPrompt = null;
    hideInstallModal();
    const sideBtn = document.getElementById('btn-sidebar-install');
    if (sideBtn) sideBtn.style.display = 'none';
    const mobBtn = document.getElementById('btn-mobile-install');
    if (mobBtn) mobBtn.style.display = 'none';
    if (window.showToast) window.showToast('Application installed successfully! 🎉');
  });

  // Setup DOM buttons once ready
  function initInstallButtons() {
    const installActionBtn = document.getElementById('btn-pwa-install-action');
    const laterBtn = document.getElementById('btn-pwa-later');
    const closeBtn = document.getElementById('btn-pwa-dismiss');
    const sideBtn = document.getElementById('btn-sidebar-install');
    const mobBtn = document.getElementById('btn-mobile-install');

    const handleInstallClick = async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const choice = await deferredPrompt.userChoice;
        console.log('[PWA] User response:', choice.outcome);
        if (choice.outcome === 'accepted') {
          hideInstallModal();
        }
        deferredPrompt = null;
      } else if (isIos) {
        showInstallModal();
      } else {
        const deskBox = document.getElementById('pwa-desktop-guide');
        if (deskBox) {
          deskBox.style.display = 'flex';
          deskBox.scrollIntoView({ behavior: 'smooth' });
        } else {
          hideInstallModal();
          alert('To install this app:\n1. Click the Install icon (⊕) in your browser address bar\n2. Or click the 3-dots browser menu ➔ "Apps" / "Install this site as an app".');
        }
      }
    };

    if (installActionBtn) installActionBtn.addEventListener('click', handleInstallClick);
    if (sideBtn) sideBtn.addEventListener('click', () => {
      if (deferredPrompt) {
        handleInstallClick();
      } else {
        showInstallModal();
      }
    });
    if (mobBtn) mobBtn.addEventListener('click', () => {
      if (deferredPrompt) {
        handleInstallClick();
      } else {
        showInstallModal();
      }
    });

    const handleDismiss = () => {
      hideInstallModal();
      localStorage.setItem('bpcl_pwa_dismissed', Date.now().toString());
    };

    if (laterBtn) laterBtn.addEventListener('click', handleDismiss);
    if (closeBtn) closeBtn.addEventListener('click', handleDismiss);

    const modal = document.getElementById('pwa-install-modal');
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) handleDismiss();
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initInstallButtons);
  } else {
    initInstallButtons();
  }

  window.triggerPWAInstall = showInstallModal;
})();
