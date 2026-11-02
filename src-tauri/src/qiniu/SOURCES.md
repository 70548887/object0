# Qiniu protocol references

This module is an independent Rust implementation of Qiniu's documented wire
protocol. It does not bundle Kodo Browser, its Electron runtime, brand assets,
logging helpers or telemetry. No user account was used to develop these tests.

Reference baseline:

- Kodo Browser commit `2c5d7bad6c44e9d57529f8f19bf0faa7c2ee27dd`, app 2.3.3:
  <https://github.com/qiniu/kodo-browser/tree/2c5d7bad6c44e9d57529f8f19bf0faa7c2ee27dd>
- Its lockfile selects `kodo-s3-adapter-sdk@0.7.1`; do not assume that SDK's public
  master branch is the same released version. Public TypeScript source was used
  to cross-check operation routing, not copied into the Rust application.
- Management V1/V2 signing and encoded-entry expected values are the public test
  vectors in Qiniu's Node.js SDK (MIT):
  <https://github.com/qiniu/nodejs-sdk/blob/master/test/util.test.js>
- Management credentials: <https://developer.qiniu.com/kodo/1201/access-token>
- Private download: <https://developer.qiniu.com/kodo/1656/download-private>
- S3 names and endpoints: <https://developer.qiniu.com/kodo/4088/s3-access-domainname>
- Bucket API: <https://developer.qiniu.com/kodo/3941/the-bucket-interface>
- Native copy/move: <https://developer.qiniu.com/kodo/1254/copy>,
  <https://developer.qiniu.com/kodo/1288/move>
- Restore: <https://developer.qiniu.com/kodo/6380/restore-archive>
- Storage type: <https://developer.qiniu.com/kodo/3710/chtype>

Important limits:

- Native form uploads remain limited to 5 MiB. Larger public-native uploads
  now use the durable native_jobs queue and encrypted native_upload_store.
  Pause/resume and record-reopen contracts are locally tested; real cloud and
  desktop-process restart acceptance are still pending. Public-native ranged
  downloads now use native_download_jobs and native_download_store with strict
  Range/identity validation and local-only commit recovery. S3/private transfer
  recovery is not enabled by these integrations.
- Native download requires an explicitly configured trusted domain and checks
  full size and Qiniu content hash before committing a local target.
- A created bucket is not reported ready until its private state is read back.
  If privacy verification fails, its empty server bucket may remain and the
  caller must keep uploads blocked until a later successful verification.
- Discovery, domain queries and HTTP contracts are tested with loopback fake
  services. Private cloud and real public Qiniu accounts still require end-to-end
  acceptance testing. A permission error is not classified as an unsupported API.
