# Release naming compatibility

The user-facing product is 云仓 (Yuncang). The executable, application identifier,
credential service, repository address and existing release asset prefix remain
`object0` for compatibility. The NSIS filename is resolved from
`tauri.conf.json`'s `productName`; distribution assets retain stable ASCII names.

The published v1.6.0 release is immutable and still contains the Chinese-only
object0 build. Do not replace its assets with the renamed bilingual build.
Create a new version and verify both distribution formats when publishing the
next release.
