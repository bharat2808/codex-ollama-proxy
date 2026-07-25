'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createAccessTokenProvider } = require('../src/google-adc');

test('ADC token provider requests cloud-platform credentials and returns access tokens', async () => {
  let options;
  let tokenRequests = 0;
  class FakeGoogleAuth {
    constructor(input) {
      options = input;
    }

    async getClient() {
      return {
        getAccessToken: async () => {
          tokenRequests += 1;
          return { token: 'adc-token' };
        },
      };
    }
  }

  const getAccessToken = createAccessTokenProvider({ GoogleAuth: FakeGoogleAuth });

  assert.equal(await getAccessToken(), 'adc-token');
  assert.equal(await getAccessToken(), 'adc-token');
  assert.deepEqual(options, {
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  assert.equal(tokenRequests, 2);
});

test('ADC token provider reports missing credentials without leaking internals', async () => {
  class MissingGoogleAuth {
    async getClient() {
      throw new Error('/private/credentials.json contained secret material');
    }
  }

  const getAccessToken = createAccessTokenProvider({ GoogleAuth: MissingGoogleAuth });

  await assert.rejects(
    getAccessToken(),
    /Vertex AI authentication failed\. Configure ADC with "gcloud auth application-default login" or pass --vertex-token\./u,
  );
});
