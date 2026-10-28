import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AccessService } from './access/access.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { LogHmacService } from './auth/log-hmac.service';
import { PasswordService } from './auth/password.service';
import { RateLimiter } from './auth/rate-limiter';
import { SessionGuard } from './auth/session.guard';
import { SessionService } from './auth/session.service';
import { StepUpService } from './auth/step-up.service';
import { SyslogService } from './auth/syslog.service';
import { UserStateService } from './auth/user-state.service';
import { ProblemFilter } from './common/problem.filter';
import { APP_CONFIG, AppConfig } from './config/config';
import { DbService } from './db/db.service';
import { TxInterceptor } from './db/tx.interceptor';
import { GroupsController } from './groups/groups.controller';
import { GroupsService } from './groups/groups.service';
import { MeController } from './me/me.controller';
import { MeService } from './me/me.service';
import { UsersController } from './users/users.controller';
import { UsersRepo } from './users/users.repo';
import { UsersService } from './users/users.service';

export function appModuleFor(config: AppConfig) {
  @Module({
    controllers: [AuthController, MeController, UsersController, GroupsController],
    providers: [
      { provide: APP_CONFIG, useValue: config },
      DbService, SyslogService, LogHmacService, PasswordService, RateLimiter, SessionService, UserStateService, StepUpService,
      AccessService, AuthService, UsersRepo, MeService, UsersService, GroupsService,
      { provide: APP_GUARD, useClass: SessionGuard },
      { provide: APP_INTERCEPTOR, useClass: TxInterceptor },
      { provide: APP_FILTER, useClass: ProblemFilter },
    ],
  })
  class AppModule {}
  return AppModule;
}
