import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.pricepe.app',
  appName: 'PricePe',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
};

export default config;
