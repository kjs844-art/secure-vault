import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { handleRequest } from "./server/runtime-policy";

const render = createStartHandler(defaultStreamHandler);

export default {
  fetch(request: Request) {
    return handleRequest(request, process.env, (incoming) => render(incoming));
  },
};
