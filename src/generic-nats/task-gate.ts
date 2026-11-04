import type { TaskService } from "../store.ts";
import type { Principal, Operation } from "../types.ts";
import {
  canonical,
  keySchema,
  type TextTaskGate,
  type TextRoute,
} from "./protocol.ts";
export function createTextTaskGate(
  tasks: TaskService,
  resolve: (route: TextRoute) => Principal | null | Promise<Principal | null>,
  now: () => number = () => Date.now(),
): TextTaskGate {
  return {
    async inspect(route, key) {
      keySchema.parse(key);
      const original = await resolve(route);
      if (!original) throw Error("text_worker_unavailable");
      const originalFingerprint = canonical(original);
      const p: Principal = {
        ...original,
        operations: [...original.operations],
        taskTypes: original.taskTypes ? [...original.taskTypes] : undefined,
        textBinding: original.textBinding
          ? { ...original.textBinding }
          : undefined,
      };
      if (
        p.subject !== route.workerSubject ||
        p.clientId !== route.workerClient ||
        p.worker !== route.binding.recipientAgent ||
        p.runnerScope !== route.boundaryId ||
        canonical(p.textBinding) !== canonical(route.binding) ||
        !p.operations.includes("get") ||
        !p.taskTypes?.includes("generic_text")
      )
        throw Error("text_worker_binding_denied");
      const bound = await tasks.authorization.bind(p);
      if (
        !(await tasks.authorization.isActive(
          route.ownerSubject,
          route.ownerClient,
        ))
      )
        throw Error("text_origin_inactive");
      if (!(await tasks.authorization.isActive(route.binding.recipientOwner)))
        throw Error("text_recipient_owner_inactive");
      const current = await resolve(route);
      if (canonical(current) !== originalFingerprint)
        throw Error("text_authorization_changed");
      const task = await tasks.get(bound, { id: key.slice(4) });
      const epoch = await tasks.authorization.epoch();
      if (epoch !== bound.authorizationEpoch)
        throw Error("text_authorization_changed");
      if (
        task.owner !== route.ownerSubject ||
        task.text_request?.ownerClient !== route.ownerClient ||
        canonical(task.text_request.binding) !== canonical(route.binding)
      )
        throw Error("text_task_binding_denied");
      const admissionOperations: readonly Operation[] = [
        "claim",
        "heartbeat",
        "complete",
      ];
      return {
        task,
        epoch,
        now: now(),
        admissionAllowed: admissionOperations.every((op) =>
          p.operations.includes(op),
        ),
      };
    },
  };
}
