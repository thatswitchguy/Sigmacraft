/**
 * Video Settings UI Controller
 * Binds HTML elements to VideoSettingsManager
 */

export class VideoSettingsUI {
  constructor(videoSettingsManager) {
    this.settings = videoSettingsManager;
    this.elements = {};
    this.initializeElements();
    this.bindEvents();
    this.updateUIFromSettings();
  }

  /**
   * Initialize references to all HTML elements
   */
  initializeElements() {
    const elementIds = [
      // Display
      'maxFpsSelect', 'vsyncCheck', 'resolutionSlider', 'resolutionValue',
      'brightnessSlider', 'brightnessValue', 'contrastSlider', 'contrastValue',
      'gammaSlider', 'gammaValue',
      
      // Graphics
      'renderDistanceSlider', 'renderDistanceValue', 'chunkDistanceSlider', 'chunkDistanceValue',
      'msaaSelect', 'shadowsEnabledCheck', 'shadowQualitySelect',
      'shadowDistanceSlider', 'shadowDistanceValue',
      
      // Effects
      'particlesEnabledCheck', 'aoCheck', 'bloomCheck', 'reflectionsCheck',
      'fluidQualitySelect',
      
      // Performance
      'lodEnabledCheck', 'hudScaleSlider', 'hudScaleValue', 'hideHandCheck', 'debugInfoCheck',
      
      // Buttons
      'autoDetectSettingsBtn', 'resetSettingsBtn', 'backFromVideoBtn', 'videoSettingsBtn', 'gameSettingsBtn'
    ];

    elementIds.forEach(id => {
      const element = document.getElementById(id);
      if (element) {
        this.elements[id] = element;
      }
    });
  }

  /**
   * Bind events to all controls
   */
  bindEvents() {
    // Display settings
    this.bindSlider('resolutionSlider', 'resolutionValue', 'resolution', '%');
    this.bindSlider('brightnessSlider', 'brightnessValue', 'brightness', '%');
    this.bindSlider('contrastSlider', 'contrastValue', 'contrast', '%');
    this.bindSlider('gammaSlider', 'gammaValue', 'gamma', '%');
    this.bindSelect('maxFpsSelect', 'maxFps', value => {
      return value === '0' ? 0 : parseInt(value);
    });
    this.bindCheckbox('vsyncCheck', 'vsync');

    // Graphics settings
    this.bindSlider('renderDistanceSlider', 'renderDistanceValue', 'renderDistance', '');
    this.bindSlider('chunkDistanceSlider', 'chunkDistanceValue', 'chunkDistance', '');
    this.bindSlider('shadowDistanceSlider', 'shadowDistanceValue', 'shadowDistance', '');
    this.bindSelect('msaaSelect', 'multisampling', value => parseInt(value));
    this.bindSelect('shadowQualitySelect', 'shadowQuality', value => parseInt(value));
    this.bindCheckbox('shadowsEnabledCheck', 'shadowsEnabled');

    // Effects
    this.bindCheckbox('particlesEnabledCheck', 'particlesEnabled');
    this.bindCheckbox('aoCheck', 'ambientOcclusion');
    this.bindCheckbox('bloomCheck', 'bloomEnabled');
    this.bindCheckbox('reflectionsCheck', 'reflectionsEnabled');
    this.bindSelect('fluidQualitySelect', 'fluidRenderQuality');

    // Performance
    this.bindCheckbox('lodEnabledCheck', 'lodEnabled');
    this.bindSlider('hudScaleSlider', 'hudScaleValue', 'hudScale', '%');
    this.bindCheckbox('hideHandCheck', 'hideHand');
    this.bindCheckbox('debugInfoCheck', 'showDebugInfo');

    // Buttons
    if (this.elements.autoDetectSettingsBtn) {
      this.elements.autoDetectSettingsBtn.addEventListener('click', () => {
        this.settings.autoDetectOptimalSettings();
        this.updateUIFromSettings();
      });
    }

    if (this.elements.resetSettingsBtn) {
      this.elements.resetSettingsBtn.addEventListener('click', () => {
        this.settings.resetToDefaults();
        this.updateUIFromSettings();
      });
    }

    if (this.elements.backFromVideoBtn) {
      this.elements.backFromVideoBtn.addEventListener('click', () => {
        this.hideVideoSettings();
      });
    }

    if (this.elements.videoSettingsBtn) {
      this.elements.videoSettingsBtn.addEventListener('click', () => {
        this.showVideoSettings();
      });
    }

    if (this.elements.gameSettingsBtn) {
      this.elements.gameSettingsBtn.addEventListener('click', () => {
        this.showGameSettings();
      });
    }
  }

  /**
   * Bind a slider to a setting
   */
  bindSlider(sliderId, valueId, settingKey, suffix = '') {
    const slider = this.elements[sliderId];
    const valueSpan = this.elements[valueId];

    if (slider) {
      slider.addEventListener('input', (e) => {
        const value = parseInt(e.target.value);
        this.settings.updateSetting(settingKey, value);
        
        if (valueSpan) {
          valueSpan.textContent = value + suffix;
        }
      });
    }
  }

  /**
   * Bind a select dropdown to a setting
   */
  bindSelect(selectId, settingKey, parser = null) {
    const select = this.elements[selectId];

    if (select) {
      select.addEventListener('change', (e) => {
        const value = parser ? parser(e.target.value) : e.target.value;
        this.settings.updateSetting(settingKey, value);
      });
    }
  }

  /**
   * Bind a checkbox to a setting
   */
  bindCheckbox(checkboxId, settingKey) {
    const checkbox = this.elements[checkboxId];

    if (checkbox) {
      checkbox.addEventListener('change', (e) => {
        this.settings.updateSetting(settingKey, e.target.checked);
      });
    }
  }

  /**
   * Update all UI elements from settings
   */
  updateUIFromSettings() {
    const settingsData = this.settings.getSettings();

    // Display
    if (this.elements.resolutionSlider) {
      this.elements.resolutionSlider.value = settingsData.resolution;
      this.elements.resolutionValue.textContent = settingsData.resolution + '%';
    }
    if (this.elements.brightnessSlider) {
      this.elements.brightnessSlider.value = settingsData.brightness;
      this.elements.brightnessValue.textContent = settingsData.brightness + '%';
    }
    if (this.elements.contrastSlider) {
      this.elements.contrastSlider.value = settingsData.contrast;
      this.elements.contrastValue.textContent = settingsData.contrast + '%';
    }
    if (this.elements.gammaSlider) {
      this.elements.gammaSlider.value = settingsData.gamma;
      this.elements.gammaValue.textContent = settingsData.gamma + '%';
    }
    if (this.elements.maxFpsSelect) {
      this.elements.maxFpsSelect.value = settingsData.maxFps;
    }
    if (this.elements.vsyncCheck) {
      this.elements.vsyncCheck.checked = settingsData.vsync;
    }

    // Graphics
    if (this.elements.renderDistanceSlider) {
      this.elements.renderDistanceSlider.value = settingsData.renderDistance;
      this.elements.renderDistanceValue.textContent = settingsData.renderDistance;
    }
    if (this.elements.chunkDistanceSlider) {
      this.elements.chunkDistanceSlider.value = settingsData.chunkDistance;
      this.elements.chunkDistanceValue.textContent = settingsData.chunkDistance;
    }
    if (this.elements.shadowDistanceSlider) {
      this.elements.shadowDistanceSlider.value = settingsData.shadowDistance;
      this.elements.shadowDistanceValue.textContent = settingsData.shadowDistance;
    }
    if (this.elements.msaaSelect) {
      this.elements.msaaSelect.value = settingsData.multisampling;
    }
    if (this.elements.shadowQualitySelect) {
      this.elements.shadowQualitySelect.value = settingsData.shadowQuality;
    }
    if (this.elements.shadowsEnabledCheck) {
      this.elements.shadowsEnabledCheck.checked = settingsData.shadowsEnabled;
    }

    // Effects
    if (this.elements.particlesEnabledCheck) {
      this.elements.particlesEnabledCheck.checked = settingsData.particlesEnabled;
    }
    if (this.elements.aoCheck) {
      this.elements.aoCheck.checked = settingsData.ambientOcclusion;
    }
    if (this.elements.bloomCheck) {
      this.elements.bloomCheck.checked = settingsData.bloomEnabled;
    }
    if (this.elements.reflectionsCheck) {
      this.elements.reflectionsCheck.checked = settingsData.reflectionsEnabled;
    }
    if (this.elements.fluidQualitySelect) {
      this.elements.fluidQualitySelect.value = settingsData.fluidRenderQuality;
    }

    // Performance
    if (this.elements.lodEnabledCheck) {
      this.elements.lodEnabledCheck.checked = settingsData.lodEnabled;
    }
    if (this.elements.hudScaleSlider) {
      this.elements.hudScaleSlider.value = settingsData.hudScale;
      this.elements.hudScaleValue.textContent = settingsData.hudScale + '%';
    }
    if (this.elements.hideHandCheck) {
      this.elements.hideHandCheck.checked = settingsData.hideHand;
    }
    if (this.elements.debugInfoCheck) {
      this.elements.debugInfoCheck.checked = settingsData.showDebugInfo;
    }
  }

  /**
   * Show video settings panel
   */
  showVideoSettings() {
    const pauseMain = document.getElementById('pauseMain');
    const pauseVideo = document.getElementById('pauseVideo');
    const pauseGame = document.getElementById('pauseGame');

    if (pauseMain) pauseMain.style.display = 'none';
    if (pauseGame) pauseGame.style.display = 'none';
    if (pauseVideo) pauseVideo.style.display = 'block';
  }

  /**
   * Show game settings panel
   */
  showGameSettings() {
    const pauseMain = document.getElementById('pauseMain');
    const pauseVideo = document.getElementById('pauseVideo');
    const pauseGame = document.getElementById('pauseGame');

    if (pauseMain) pauseMain.style.display = 'none';
    if (pauseVideo) pauseVideo.style.display = 'none';
    if (pauseGame) pauseGame.style.display = 'block';
  }

  /**
   * Hide video settings panel
   */
  hideVideoSettings() {
    const pauseMain = document.getElementById('pauseMain');
    const pauseVideo = document.getElementById('pauseVideo');

    if (pauseVideo) pauseVideo.style.display = 'none';
    if (pauseMain) pauseMain.style.display = 'block';
  }

  /**
   * Hide game settings panel
   */
  hideGameSettings() {
    const pauseMain = document.getElementById('pauseMain');
    const pauseGame = document.getElementById('pauseGame');

    if (pauseGame) pauseGame.style.display = 'none';
    if (pauseMain) pauseMain.style.display = 'block';
  }
}

export default VideoSettingsUI;
