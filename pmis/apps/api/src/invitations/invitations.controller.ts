import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { Auth, Public } from "../auth/decorators";
import type { AuthContext } from "../auth/auth.types";
import { InvitationDto, InvitationsService } from "./invitations.service";

/** Admin side: /users/invitations. Registered before UsersController so that it is not read as /users/{user_id}. */
@Controller("users/invitations")
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.invitations.list(query);
  }

  @Post()
  @HttpCode(201)
  create(
    @Auth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<InvitationDto> {
    return this.invitations.create(auth, body);
  }

  @Post(":id/resend")
  @HttpCode(200)
  resend(
    @Auth() auth: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<InvitationDto> {
    return this.invitations.resend(auth, id, body);
  }

  @Post(":id/revoke")
  @HttpCode(200)
  revoke(
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<InvitationDto> {
    return this.invitations.revoke(id, body);
  }
}

/** Public side: the page of the mailed link. No session; every failure answers the same 404. */
@Controller("invitations")
export class PublicInvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Public()
  @Get(":token")
  preview(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("token") token: string,
  ) {
    res.setHeader("Cache-Control", "no-store");
    return this.invitations.preview(token, req.ip ?? null);
  }

  @Public()
  @Post(":token/accept")
  @HttpCode(201)
  accept(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("token") token: string,
    @Body() body: unknown,
  ) {
    res.setHeader("Cache-Control", "no-store");
    return this.invitations.accept(token, req.ip ?? null, body);
  }
}
