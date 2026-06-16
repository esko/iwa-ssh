/**
 * IWA runtime enforces require-trusted-types-for 'script'. Without a default
 * policy, innerHTML assignments throw and the UI stays blank (#202124).
 */

type TrustedTypePolicyFactory = {
  createPolicy: (
    name: string,
    rules: {
      createHTML?: (input: string) => string;
      createScriptURL?: (input: string) => string;
      createScript?: (input: string) => string;
    },
  ) => unknown;
};

declare global {
  interface Window {
    trustedTypes?: TrustedTypePolicyFactory;
  }
}

export function initTrustedTypesPolicy(): void {
  const tt = window.trustedTypes;
  if (!tt?.createPolicy) return;

  try {
    tt.createPolicy('default', {
      createHTML: (html: string) => html,
      createScriptURL: (url: string) => url,
      createScript: (script: string) => script,
    });
  } catch {
    // Default policy already registered (HMR / double init).
  }
}

initTrustedTypesPolicy();
