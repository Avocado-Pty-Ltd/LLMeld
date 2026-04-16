export enum Brand {
  EZYBIZ,
  CALLCONCIERGE
}

export const BRAND_DISPLAY_NAMES: Record<Brand, string> = {
  [Brand.EZYBIZ]: 'EzyBiz',
  [Brand.CALLCONCIERGE]: 'CallConcierge'
};

// Environment-based brand selection
export const CURRENT_BRAND: Brand = (process.env.REACT_APP_BRAND as Brand) || Brand.EZYBIZ;

// Brand-specific configurations
export const BRAND_CONFIGS: Record<Brand, { 
  displayName: string;
  primaryColor: string;
  logoPath: string;
  websiteUrl: string;
}> = {
  [Brand.EZYBIZ]: {
    displayName: 'EzyBiz',
    primaryColor: '#4A90E2',
    logoPath: '/logos/ezybiz-logo.svg',
    websiteUrl: 'https://ezybiz.com'
  },
  [Brand.CALLCONCIERGE]: {
    displayName: 'CallConcierge',
    primaryColor: '#50B83C',
    logoPath: '/logos/callconcierge-logo.svg',
    websiteUrl: 'https://callconcierge.com'
  }
};

// Feature flags for brand-specific functionality
export const BRAND_FEATURE_FLAGS: Record<Brand, {
  enableAdvancedReporting: boolean;
  enableCustomIntegrations: boolean;
}> = {
  [Brand.EZYBIZ]: {
    enableAdvancedReporting: true,
    enableCustomIntegrations: true
  },
  [Brand.CALLCONCIERGE]: {
    enableAdvancedReporting: false,
    enableCustomIntegrations: false
  }
};