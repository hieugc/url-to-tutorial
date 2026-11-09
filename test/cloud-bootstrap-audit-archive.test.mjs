test('Cloud bootstrap exposes only the narrow audit archive capability for host scheduling', async () => {
  const calls = [];
  const bootstrap = await createCloudStudioFromSecretManager({
    secretManager: { readCloudSecrets: async () => snapshot('1') },
    createStudioServerImpl: options => {
      const studio = fakeFactory(calls)(options);
      studio.auditAdmin.archiveBatch = async ({ limit = 500 } = {}) => {
        calls.push({ archiveLimit: limit });
        return { archived: 1, lastArchivedSequence: 1 };
      };
      return studio;
    },
  });
  assert.equal(Object.hasOwn(bootstrap, 'auditAdmin'), false);
  assert.equal(Object.hasOwn(bootstrap, 'tokenAdmin'), false);
  assert.deepEqual(await bootstrap.archiveAuditBatch({ limit: 25 }), {
    archived: 1, lastArchivedSequence: 1,
  });
  assert.deepEqual(calls.at(-1), { archiveLimit: 25 });
});

