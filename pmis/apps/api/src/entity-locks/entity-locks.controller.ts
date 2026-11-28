import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import type { AuthContext } from "../auth/auth.types";
import { Auth } from "../auth/decorators";
import { oneParam, type Query as Q } from "../common/query";
import { EntityLocksService } from "./entity-locks.service";

/** Contract tag `locks`: lock and unlock a Warehouse item or movement, a Daily Plan or one of its rows, or a column of them (migration 0565). */
@Controller("entity-locks")
export class EntityLocksController {
  constructor(private readonly locks: EntityLocksService) {}

  @Get()
  list(@Query() q: Q) {
    return this.locks.list(oneParam(q, "kind"));
  }

  @Post("columns/:kind/:field")
  @HttpCode(200)
  lockColumn(@Auth() auth: AuthContext, @Param("kind") kind: string, @Param("field") field: string, @Body() body: unknown) {
    return this.locks.setColumnLock(auth, kind, field, body, true);
  }

  @Delete("columns/:kind/:field")
  @HttpCode(200)
  unlockColumn(@Auth() auth: AuthContext, @Param("kind") kind: string, @Param("field") field: string, @Body() body: unknown) {
    return this.locks.setColumnLock(auth, kind, field, body, false);
  }

  @Post(":kind/:id")
  @HttpCode(200)
  lock(@Auth() auth: AuthContext, @Param("kind") kind: string, @Param("id") id: string, @Body() body: unknown) {
    return this.locks.setLock(auth, kind, id, body, true);
  }

  @Delete(":kind/:id")
  @HttpCode(200)
  unlock(@Auth() auth: AuthContext, @Param("kind") kind: string, @Param("id") id: string, @Body() body: unknown) {
    return this.locks.setLock(auth, kind, id, body, false);
  }
}
