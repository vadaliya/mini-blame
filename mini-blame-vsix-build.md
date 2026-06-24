# Building the VS Code Extension (.vsix)

This document provides instructions on how to build and package the `mini-blame` VS Code extension into a `.vsix` installer file.

## Prerequisites

Ensure you have Node.js and npm installed, and all dependencies resolved:
```bash
npm install
```

## How to Package the Extension

To clean, compile, and package the extension, execute the following commands in the root directory:

1. Clean npm cache and clear any previous build outputs:
   ```cmd
   npm cache clean --force
   rmdir /s /q out
   ```

2. Compile the TypeScript source code:
   ```cmd
   npm run compile
   ```

3. Package the extension using the local `vsce` executable:
   ```cmd
   npx vsce package
   ```
   This will generate a file named `mini-blame-0.0.4.vsix` in the root folder.

## Installing the `.vsix` Locally

To test the packaged extension in your local VS Code editor:
1. Open VS Code.
2. Open the Extensions view (`Ctrl+Shift+X`).
3. Click the `...` (More Actions) button in the top-right of the Extensions view.
4. Select **Install from VSIX...**.
5. Select the generated `mini-blame-0.0.4.vsix` file.
