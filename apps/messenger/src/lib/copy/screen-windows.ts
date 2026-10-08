import type { CopyShape } from "./shape.ts";

/** The phone's words where the computer it reached is a Windows PC behind a VNC server (`screenCopy`). */

export const zh = {
  title: "电脑屏幕",
  connecting: "正在连接电脑屏幕…",
  linking: "正在连接电脑…",
  waitingMac: "正在等电脑上的 VNC 服务回应…",
  noAnswer: "电脑上的 VNC 服务没有回应。",
  signInTitle: "登录这台电脑的 VNC 服务",
  signInHint: "用 VNC 服务里设的密码，不是 Windows 账户密码。",
  wrongPassword: "密码不对，VNC 服务拒绝了。",
  disabledOnMac: "这台电脑没有允许远程屏幕。在电脑上打开 设置 → 远程控制，打开「允许看和操作这台电脑的屏幕」。",
  sharingOff: "电脑上没找到 VNC 服务。在电脑上装好 TightVNC（注册成系统服务），并允许本机回环连接。",
  failed: "连不上电脑屏幕。",
};

export const en: CopyShape<typeof zh> = {
  title: "Computer screen",
  connecting: "Connecting to the computer's screen…",
  linking: "Connecting to the computer…",
  waitingMac: "Waiting for the computer's VNC server to answer…",
  noAnswer: "The computer's VNC server did not answer.",
  signInTitle: "Sign in to this computer's VNC server",
  signInHint: "Use the password set in the VNC server, not the Windows account password.",
  wrongPassword: "The VNC server refused that password.",
  disabledOnMac: "This computer does not allow its screen to be shown. On the computer, open Settings → Remote access and turn on \"Allow viewing and controlling this computer's screen\".",
  sharingOff: "No VNC server found on the computer. Install TightVNC there (registered as a system service) and allow loopback connections.",
  failed: "Could not reach the computer's screen.",
};
