/**
 * Brand configuration module for EzyBiz and CallConcierge apps
 * This module will help detect which brand is currently running
 */

// Simple brand detection based on development environment
// In a real implementation, this would use the actual BuildConfig.FLAVOR
// or a native module to detect the correct brand
export const getBrand = () => {
  // For now, we'll use __DEV__ to distinguish between brands in dev
  // In production, this would be determined by the native build configuration
  if (__DEV__) {
    // In development, we can manually test by changing this
    return 'ezyBiz';
  }
  // For production, this would be set by the native build system
  return 'ezyBiz'; // Default brand
};

// Brand-specific configurations
export const BRANDS = {
  EZY_BIZ: 'ezyBiz',
  CALL_CONCIERGE: 'callConcierge'
};

// Brand constants
export const BRAND = getBrand();

// Brand-specific colors and settings
export const BRAND_CONFIG = {
  [BRANDS.EZY_BIZ]: {
    primaryColor: '#007AFF',
    secondaryColor: '#5856D6',
    appName: 'EzyBiz',
    appTitle: 'EzyBiz',
    // Add more brand-specific settings here
  },
  [BRANDS.CALL_CONCIERGE]: {
    primaryColor: '#007AFF',
    secondaryColor: '#5856D6',
    appName: 'CallConcierge',
    appTitle: 'CallConcierge',
    // Add more brand-specific settings here
  },
};

// Get brand-specific configuration
export const getBrandConfig = () => {
  return BRAND_CONFIG[BRAND] || BRAND_CONFIG[BRANDS.EZY_BIZ];
};

// Export brand-specific values
export const BRAND_NAME = BRAND;
export const BRAND_COLORS = getBrandConfig().primaryColor;