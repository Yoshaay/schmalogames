// esbuild bündelt PNGs als Data-URL (siehe build.mjs, loader '.png')
declare module '*.png' {
  const dataUrl: string;
  export default dataUrl;
}

// 3D-Modelle als Binärdaten (loader '.fbx')
declare module '*.fbx' {
  const data: Uint8Array;
  export default data;
}
