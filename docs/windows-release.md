# Windows releases

Seamind releases are built on GitHub Actions from version tags. The workflow builds the NSIS installer, signs its updater artifact, and publishes `latest.json` with the release assets.

## Signing key

The Tauri updater rejects unsigned packages. The private key and its password must remain outside the repository; only the public key belongs in `apps/desktop/src-tauri/tauri.conf.json`.

On the release maintainer's Windows machine, authenticate GitHub CLI and set these repository Actions secrets from local files. Do not paste key material into source files or commit it:

```powershell
gh auth login
cmd.exe /d /c 'gh secret set TAURI_SIGNING_PRIVATE_KEY --repo ltm84532430-max/Seamind < "%USERPROFILE%\.tauri\seamind.key"'
cmd.exe /d /c 'gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo ltm84532430-max/Seamind < "%USERPROFILE%\.tauri\seamind-signing-password.txt"'
```

Keep a protected offline backup of both local files. Losing the private key prevents publishing trusted updates for already installed builds. Never replace it without a planned key rotation.

## Publish

1. Update the same SemVer in `apps/desktop/package.json`, `apps/desktop/src-tauri/Cargo.toml`, and `apps/desktop/src-tauri/tauri.conf.json`.
2. Commit the release source to `main` and let the CI workflow finish.
3. Create and push the matching tag, for example `v0.1.0`:

   ```powershell
   git tag v0.1.0
   git push origin v0.1.0
   ```

The `Publish Seamind for Windows` workflow creates a public GitHub Release with the NSIS installer, its updater signature, and `latest.json`. The in-app updater reads the latest release and verifies the signed version and artifact before offering installation.

## User update flow

In Seamind, open **模型设置 → Seamind 软件更新 → 检查更新**. The app contacts GitHub only when the user selects this control. If an update is available, the user can review its version and release notes before downloading and installing it.
