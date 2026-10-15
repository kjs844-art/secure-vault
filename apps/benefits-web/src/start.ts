// The source app explicitly reinstalls CSRF after defining its own start entry.
import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

export const startInstance = createStart(() => ({
  requestMiddleware: [
    createCsrfMiddleware({ filter: (context) => context.handlerType === "serverFn" }),
  ],
}));
