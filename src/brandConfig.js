/**
 * Brand configuration module for EzyBiz and CallConcierge apps
 * This module will help detect which brand is currently running
 * and provide brand-specific settings based on build-time configuration
 */

// Check if we're in a React Native environment
const isReactNative = typeof navigator !== 'undefined' && navigator.product === 'ReactNative';

// Helper to determine brand at runtime
export const getBrand = () => {
  // For React Native, attempt to get brand from native module or process.env
  if (isReactNative) {
    try {
      // Try to access a globally set brand variable (this would be set via native code)
      if (typeof global !== 'undefined' && global.__BRAND__) {
        return global.__BRAND__;
      }
      // Try process.env if available
      if (typeof process !== 'undefined' && process.env && process.env.BRAND) {
        return process.env.BRAND;
      }
    } catch (e) {
      // If there's an error, fall back to default
    }
    // Default fallback for React Native - this will be set in native code
    return 'ezyBiz';
  }
  
  // For non-React Native environments (server-side, testing, etc.)
  if (typeof process !== 'undefined' && process.env) {
    return process.env.BRAND || 'ezyBiz';
  }
  
  // Default fallback for development
  return 'ezyBiz';
};

// Brand constants based on product flavors
export const BRANDS = {
  EZY_BIZ: 'ezyBiz',
  CALL_CONCIERGE: 'callConcierge'
};

// Current brand detection
export const BRAND = getBrand();

// Brand-specific configurations for React Native app settings
export const BRAND_CONFIG = {
  [BRANDS.EZY_BIZ]: {
    appName: 'EzyBiz',
    appTitle: 'EzyBiz',
    primaryColor: '#007AFF',
    secondaryColor: '#5856D6',
    backgroundColor: '#ffffff',
    // Additional brand-specific UI settings
    appIcon: 'ezybiz_app_icon',
    splashScreen: 'ezybiz_splash',
  },
  [BRANDS.CALL_CONCIERGE]: {
    appName: 'CallConcierge',
    appTitle: 'CallConcierge',
    primaryColor: '#007AFF',
    secondaryColor: '#5856D6',
    backgroundColor: '#ffffff',
    // Additional brand-specific UI settings
    appIcon: 'callconcierge_app_icon',
    splashScreen: 'callconcierge_splash',
  },
};

// Get brand configuration with fallback
export const getBrandConfig = () => {
  const config = BRAND_CONFIG[BRAND] || BRAND_CONFIG[BRANDS.EZY_BIZ];
  return config;
};

// Export functions to get specific brand values
export const getAppName = () => {
  return getBrandConfig().appName || 'EzyBiz';
};

export const getAppTitle = () => {
  return getBrandConfig().appTitle || 'EzyBiz';
};

export const getPrimaryColor = () => {
  return getBrandConfig().primaryColor || '#007AFF';
};

export const getSecondaryColor = () => {
  return getBrandConfig().secondaryColor || '#5856D6';
};

// Export brand configuration object for direct access
export const brandConfig = {
  currentBrand: BRAND,
  appName: getAppName(),
  appTitle: getAppTitle(),
  primaryColor: getPrimaryColor(),
  secondaryColor: getSecondaryColor(),
  config: getBrandConfig()
};

// This function would be called from the native code to set the brand
// For example, after native build configuration is complete:
export const setBrand = (brand) => {
  if (isReactNative) {
    if (typeof global !== 'undefined') {
      global.__BRAND__ = brand;
    }
    // Reset BRAND constant to ensure it uses updated value
    Object.defineProperty(exports, 'BRAND', {
      value: brand,
      writable: false, 
      enumerable: true,
      configurable: false
    });
  }
};

// Export all for easy imports
export default {
  BRANDS,
  BRAND,
  BRAND_CONFIG,
  getBrand,
  getBrandConfig,
  getAppName,
  getAppTitle,
  getPrimaryColor,
  getSecondaryColor,
  brandConfig
};