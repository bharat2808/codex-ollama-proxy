'use strict';

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const AUTH_ERROR = 'Vertex AI authentication failed. Configure ADC with '
  + '"gcloud auth application-default login" or pass --vertex-token.';

function createAccessTokenProvider(options = {}) {
  const GoogleAuth = options.GoogleAuth || require('google-auth-library').GoogleAuth;
  const auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
  let clientPromise;

  return async function getAccessToken() {
    try {
      if (!clientPromise) clientPromise = auth.getClient();
      const client = await clientPromise;
      const result = await client.getAccessToken();
      const token = typeof result === 'string' ? result : result && result.token;
      if (!token) throw new Error('ADC returned an empty access token');
      return token;
    } catch {
      const error = new Error(AUTH_ERROR);
      error.statusCode = 401;
      throw error;
    }
  };
}

module.exports = {
  AUTH_ERROR,
  CLOUD_PLATFORM_SCOPE,
  createAccessTokenProvider,
};
