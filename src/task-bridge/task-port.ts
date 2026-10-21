/** Host binds a separately verified Task Principal. Relay names never become Task permissions. */
import type { Principal } from "../types.ts";
import type { TaskService } from "../store.ts";
import { bindingSchema, taskEvidence, TaskBridgeError } from "./contract.ts";
import type { BridgeTasks, TaskBinding } from "./contract.ts";
export class ConnectivityTaskPort implements BridgeTasks {
  readonly binding: Readonly<TaskBinding>;
  readonly #service: Pick<TaskService, "submit" | "get">;
  readonly #principal: () =>
    Principal | undefined | Promise<Principal | undefined>;
  constructor(
    service: Pick<TaskService, "submit" | "get">,
    binding: TaskBinding,
    principal: () =>
      Principal | undefined | Promise<Principal | undefined> = () => undefined,
  ) {
    try {
      this.binding = Object.freeze(bindingSchema.parse(binding));
      if (
        typeof service?.submit !== "function" ||
        typeof service?.get !== "function" ||
        typeof principal !== "function"
      )
        throw Error();
    } catch {
      throw new TaskBridgeError("invalid_bridge_task_port");
    }
    this.#service = Object.freeze({
      submit: service.submit.bind(service),
      get: service.get.bind(service),
    });
    this.#principal = principal;
  }
  async #verified(operation: "submit" | "get") {
    const p = await this.#principal();
    if (
      !p ||
      p.subject !== this.binding.owner_subject ||
      (p.clientId ?? null) !== this.binding.client_id ||
      p.destination !== "hermes" ||
      !p.operations.includes(operation) ||
      !(p.taskTypes ?? ["connectivity_check"]).includes("connectivity_check")
    )
      throw new TaskBridgeError("bridge_forbidden");
    return p;
  }
  async submit(requestKey: string) {
    const p = await this.#verified("submit");
    return taskEvidence(
      await this.#service.submit(p, {
        task_type: "connectivity_check",
        request_key: requestKey,
      }),
      this.binding,
      requestKey,
    );
  }
  async get(id: string, requestKey: string) {
    const p = await this.#verified("get");
    return taskEvidence(
      await this.#service.get(p, { id }),
      this.binding,
      requestKey,
    );
  }
}
