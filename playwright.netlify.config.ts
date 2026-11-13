import { defineConfig } from '@playwright/test';
import local from './playwright.config';

export default defineConfig({
  ...local,
  webServer:{
    command:'node tests/serve-netlify.mjs',
    url:'http://127.0.0.1:8765/',
    reuseExistingServer:false,
  },
});
