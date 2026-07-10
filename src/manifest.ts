interface ManifestV3 {
  name: string;
  version: string;
  manifest_version: 3;
  description: string;
  permissions: string[];
  host_permissions: string[];
  background: {
    service_worker: string;
    type: 'module';
  };
  content_scripts: Array<{
    matches: string[];
    js: string[];
    run_at: 'document_idle' | 'document_start' | 'document_end';
  }>;
  side_panel: {
    default_path: string;
  };
  options_page: string;
  content_security_policy: {
    extension_pages: string;
  };
  web_accessible_resources: Array<{
    resources: string[];
    matches: string[];
  }>;
  icons: {
    16: string;
    48: string;
    128: string;
  };
  minimum_chrome_version: string;
}

const manifest: ManifestV3 = {
  name: 'Chrome AI Assistant',
  version: '1.0.0',
  manifest_version: 3,
  description:
    'AI-powered browser assistant that reads tabs, follows links, and generates documents using NVIDIA Nemotron models',
  permissions: ['activeTab', 'scripting', 'storage', 'sidePanel', 'tabs', 'offscreen'],
  host_permissions: ['<all_urls>'],
  background: {
    service_worker: 'background/index.js',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['content-script/index.js'],
      run_at: 'document_idle',
    },
  ],
  side_panel: {
    default_path: 'sidepanel/index.html',
  },
  options_page: 'options/index.html',
  content_security_policy: {
    extension_pages:
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https://integrate.api.nvidia.com https://api.nvidia.com https://huggingface.co",
  },
  web_accessible_resources: [
    {
      resources: ['offscreen.html', 'wasm/*'],
      matches: ['<all_urls>'],
    },
  ],
  icons: {
    16: 'icons/icon-16.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
  minimum_chrome_version: '116',
};

export default manifest;

export function generateManifest(): string {
  return JSON.stringify(manifest, null, 2);
}
