# 过山车工坊

一个基于 Three.js 的浏览器游戏：设计过山车轨道，然后乘坐自己设计的过山车。游戏提供快速和专业两种设计模式，支持保存、读取以及导入和导出设计。

## 运行

需要安装 Node.js。项目使用本地静态文件服务器，无需安装第三方 npm 包。

在项目目录运行：

```bash
node server.js
```

然后打开 <http://localhost:5173>。Windows 用户也可以双击 `启动游戏.bat`。建议使用新版 Chrome 或 Edge。

默认端口为 5173，可通过环境变量 `PORT` 修改。按 `Ctrl+C` 停止服务器。

## 项目结构

- `index.html`、`css/`、`js/`：游戏界面与逻辑。
- `assets/`：模型和贴图素材。
- `vendor/`：项目使用的 Three.js 文件及其许可证。
- `design/`：封面和图标。
- `server.js`：本地静态文件服务器。
