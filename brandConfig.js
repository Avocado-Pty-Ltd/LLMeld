// Brand configuration for EzyBiz and CallConcierge apps
const brandConfig = {
  ezyBiz: {
    appName: "EzyBiz",
    appTitle: "EzyBiz",
    appDescription: "EzyBiz Application",
    appIcon: "ic_launcher_ezybiz",
    theme: {
      primaryColor: "#4CAF50",
      secondaryColor: "#2E7D32",
      accentColor: "#81C784"
    },
    urls: {
      api: "https://api.ezybiz.com",
      support: "https://support.ezybiz.com"
    },
    features: {
      premium: true,
      analytics: true
    }
  },
  callConcierge: {
    appName: "CallConcierge",
    appTitle: "CallConcierge",
    appDescription: "CallConcierge Application",
    appIcon: "ic_launcher_callconcierge",
    theme: {
      primaryColor: "#2196F3",
      secondaryColor: "#1565C0",
      accentColor: "#64B5F6"
    },
    urls: {
      api: "https://api.callconcierge.com",
      support: "https://support.callconcierge.com"
    },
    features: {
      premium: false,
      analytics: false
    }
  }
};

// Determine brand based on environment variable
const currentBrand = process.env.BRAND || 'ezyBiz';

// Export the configuration for the current brand
const config = brandConfig[currentBrand] || brandConfig.ezyBiz;

// Export both the config and the brand identifier
module.exports = {
  config: config,
  brand: currentBrand
};