// Stands in for a sanitizer caught in native code: terminate() does not reach a running pattern. A few seconds' worth here, so tests do not leave a core spinning.
export {};
declare const self: Worker;
self.onmessage = () => {
  /^-?0*\.?0*(?:px)?$/.test(`${"0".repeat(90_000)}x`);
};
