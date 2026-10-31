// 打 Windows 包时删掉用不到的 Chromium 图形组件：
// dxcompiler 是 DirectX 着色器编译器（WebGPU/Dawn 用），
// vk_swiftshader + vulkan-1 是 Vulkan 软件回退。
// 这个 App 只有 HTML/CSS，没有 canvas/WebGL/WebGPU，删掉不影响渲染。
const fs = require('fs');
const path = require('path');

const DROP = ['dxcompiler.dll', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll'];

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  let saved = 0;
  for (const name of DROP) {
    const file = path.join(context.appOutDir, name);
    try {
      saved += fs.statSync(file).size;
      fs.unlinkSync(file);
    } catch (e) {
      // 不同 Electron 版本里的组件不完全一样，没有就算了
    }
  }
  console.log('  • 精简掉未使用的图形组件 ' + (saved / 1048576).toFixed(1) + ' MB');
};
