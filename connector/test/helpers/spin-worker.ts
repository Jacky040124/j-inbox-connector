export {};
// Stands in for the sanitizer's worker when it never answers.
declare const self: Worker;
self.onmessage = () => {
  for (;;) {}
};
