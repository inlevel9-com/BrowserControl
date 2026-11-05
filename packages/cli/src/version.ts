declare const __BCTL_VERSION__: string;
export const VERSION: string = typeof __BCTL_VERSION__ === "string" ? __BCTL_VERSION__ : "0.0.0-dev";
