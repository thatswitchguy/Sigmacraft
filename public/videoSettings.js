/**
 * Enhanced Video Settings Manager
 * Handles all video/graphics settings for the game
 */

export class VideoSettingsManager {
  constructor() {
    this.settings = {
      // Display
      resolution: 100,
      brightness: 90,
      contrast: 100,
      gamma: 100,
      
      // Graphics
      renderDistance: 10,
      chunkDistance: 8,
      shadowDistance: 50,
      shadowQuality: 2048, // 1024, 2048, 4096
      
      // Effects
      shadowsEnabled: true,
      particlesEnabled: true,
      ambientOcclusion: false,
      bloomEnabled: false,
      
      // Performance
      maxFps: 120,
      vsync: true,
      multisampling: 4, // MSAA: 0, 2, 4, 8
      lodEnabled: true,
      
      // UI
      hideHand: false,
      hudScale: 100,
      showDebugInfo: false,
      
      // Water/Fluids
      fluidRenderQuality: 'high', // low, medium, high
      reflectionsEnabled: false
    };

    this.loadSettings();
  }

  /**
   * Save settings to localStorage
   */
  saveSettings() {
    try {
      localStorage.setItem('videoSettings', JSON.stringify(this.settings));
    } catch (e) {
      console.warn("Could not save video settings:", e);
    }
  }

  /**
   * Load settings from localStorage
   */
  loadSettings() {
    try {
      const saved = localStorage.getItem('videoSettings');
      if (saved) {
        const parsed = JSON.parse(saved);
        this.settings = { ...this.settings, ...parsed };
      }
    } catch (e) {
      console.warn("Could not load video settings:", e);
    }
  }

  /**
   * Update a single setting
   */
  updateSetting(key, value) {
    if (key in this.settings) {
      this.settings[key] = value;
      this.saveSettings();
      this.applySetting(key, value);
      return true;
    }
    return false;
  }

  /**
   * Apply a setting to the renderer/game
   */
  applySetting(key, value) {
    switch (key) {
      case 'brightness':
      case 'contrast':
      case 'gamma':
        this.applyColorCorrection();
        break;
      case 'renderDistance':
      case 'chunkDistance':
        this.onRenderDistanceChange?.(value);
        break;
      case 'shadowsEnabled':
      case 'shadowQuality':
      case 'shadowDistance':
        this.onShadowSettingChange?.({ quality: this.settings.shadowQuality, distance: this.settings.shadowDistance, enabled: this.settings.shadowsEnabled });
        break;
      case 'maxFps':
        this.onFpsLimitChange?.(value);
        break;
      case 'hideHand':
        this.onHideHandChange?.(value);
        break;
      case 'particlesEnabled':
        this.onParticlesChange?.(value);
        break;
      case 'bloomEnabled':
      case 'ambientOcclusion':
        this.onPostProcessingChange?.();
        break;
    }
  }

  /**
   * Apply color correction to the page
   */
  applyColorCorrection() {
    const brightness = this.settings.brightness;
    const contrast = this.settings.contrast;
    const gamma = this.settings.gamma;

    // Apply CSS filter
    const filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${gamma}%)`;
    document.body.style.filter = filter;
  }

  /**
   * Get all settings
   */
  getSettings() {
    return { ...this.settings };
  }

  /**
   * Reset to default settings
   */
  resetToDefaults() {
    this.settings = {
      resolution: 100,
      brightness: 100,
      contrast: 100,
      gamma: 100,
      renderDistance: 10,
      chunkDistance: 8,
      shadowDistance: 50,
      shadowQuality: 2048,
      shadowsEnabled: true,
      particlesEnabled: true,
      ambientOcclusion: false,
      bloomEnabled: false,
      maxFps: 120,
      vsync: true,
      multisampling: 4,
      lodEnabled: true,
      hideHand: false,
      hudScale: 100,
      showDebugInfo: false,
      fluidRenderQuality: 'high',
      reflectionsEnabled: false
    };
    this.saveSettings();
    this.applyAllSettings();
  }

  /**
   * Apply all settings
   */
  applyAllSettings() {
    Object.entries(this.settings).forEach(([key, value]) => {
      this.applySetting(key, value);
    });
  }

  /**
   * Get recommended settings based on device capabilities
   */
  getRecommendedSettings() {
    const performance = this.getDevicePerformanceLevel();
    
    switch (performance) {
      case 'low':
        return {
          renderDistance: 5,
          shadowsEnabled: false,
          particlesEnabled: true,
          maxFps: 30,
          multisampling: 0,
          shadowQuality: 1024
        };
      case 'medium':
        return {
          renderDistance: 5,
          shadowsEnabled: true,
          particlesEnabled: true,
          maxFps: 60,
          multisampling: 2,
          shadowQuality: 2048
        };
      case 'high':
      default:
        return {
          renderDistance: 10,
          shadowsEnabled: true,
          particlesEnabled: true,
          maxFps: 120,
          multisampling: 4,
          shadowQuality: 4096,
          bloomEnabled: true,
          reflectionsEnabled: true
        };
    }
  }

  /**
   * Detect device performance level
   */
  getDevicePerformanceLevel() {
    const gpu = navigator.gpu;
    const cores = navigator.hardwareConcurrency || 1;
    const memory = navigator.deviceMemory || 4;

    if (gpu || cores >= 8 && memory >= 8) {
      return 'high';
    } else if (cores >= 4 && memory >= 4) {
      return 'medium';
    } else {
      return 'low';
    }
  }

  /**
   * Auto-detect and apply optimal settings
   */
  autoDetectOptimalSettings() {
    const recommended = this.getRecommendedSettings();
    Object.entries(recommended).forEach(([key, value]) => {
      this.updateSetting(key, value);
    });
  }

  /**
   * Register callbacks for setting changes
   */
  onRenderDistanceChange = null;
  onShadowSettingChange = null;
  onFpsLimitChange = null;
  onHideHandChange = null;
  onParticlesChange = null;
  onPostProcessingChange = null;
}

export default VideoSettingsManager;
