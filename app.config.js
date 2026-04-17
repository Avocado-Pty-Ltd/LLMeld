module.exports = ({ config }) => {
  const brand = process.env.BRAND || 'ezybiz';
  
  const brandConfigs = {
    ezybiz: {
      name: 'EzyBiz',
      slug: 'ezybiz',
      scheme: 'ezybiz',
      version: '1.0.0',
      orientation: 'portrait',
      icon: './assets/ezybiz/icon.png',
      userInterfaceStyle: 'light',
      splash: {
        image: './assets/ezybiz/splash.png',
        resizeMode: 'contain',
        backgroundColor: '#ffffff'
      },
      ios: {
        bundleIdentifier: 'com.ezybiz.app',
        buildNumber: '1.0.0'
      },
      android: {
        package: 'com.ezybiz.app',
        adaptiveIcon: {
          foregroundImage: './assets/ezybiz/adaptive-icon.png',
          backgroundColor: '#ffffff'
        }
      },
      web: {
        favicon: './assets/ezybiz/favicon.png'
      }
    },
    callconcierge: {
      name: 'CallConcierge',
      slug: 'callconcierge',
      scheme: 'callconcierge',
      version: '1.0.0',
      orientation: 'portrait',
      icon: './assets/callconcierge/icon.png',
      userInterfaceStyle: 'light',
      splash: {
        image: './assets/callconcierge/splash.png',
        resizeMode: 'contain',
        backgroundColor: '#000000'
      },
      ios: {
        bundleIdentifier: 'com.callconcierge.app',
        buildNumber: '1.0.0'
      },
      android: {
        package: 'com.callconcierge.app',
        adaptiveIcon: {
          foregroundImage: './assets/callconcierge/adaptive-icon.png',
          backgroundColor: '#000000'
        }
      },
      web: {
        favicon: './assets/callconcierge/favicon.png'
      }
    }
  };

  if (!brandConfigs[brand]) {
    throw new Error(`Invalid brand: ${brand}. Valid brands are: ezybiz, callconcierge`);
  }

  return {
    ...brandConfigs[brand],
    platforms: ['ios', 'android', 'web'],
    experiments: {
      tsconfigPaths: true
    }
  };
};