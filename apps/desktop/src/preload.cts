const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fstDesktop", {
  paperTraderBaseUrl: process.env.DESKTOP_API_BASE_URL ?? "http://127.0.0.1:8787",
  getOpsSnapshot: () => ipcRenderer.invoke("fst:get-ops-snapshot")
});
