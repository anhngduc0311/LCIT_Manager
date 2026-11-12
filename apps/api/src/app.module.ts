import { Module } from '@nestjs/common';
import { AuditController } from './controllers/audit.controller';
import { AuthController } from './controllers/auth.controller';
import { ApplicationDatabasesController, catalogControllers } from './controllers/catalog.controller';
import { HealthController } from './controllers/health.controller';
import { infrastructureControllers } from './controllers/infrastructure.controller';
import { SearchController } from './controllers/search.controller';
import { UsersController } from './controllers/users.controller';
import { SessionGuard } from './guards/session.guard';
import { AuditService } from './models/audit.service';
import { AuthService } from './models/auth.service';
import { CatalogService } from './models/catalog.service';
import { Database } from './models/database';
import { InfrastructureService } from './models/infrastructure.service';
import { SearchService } from './models/search.service';
import { UsersService } from './models/users.service';

@Module({
  controllers: [HealthController, AuthController, UsersController, AuditController, ...catalogControllers, ApplicationDatabasesController,
    ...infrastructureControllers, SearchController],
  providers: [Database, AuditService, AuthService, UsersService, CatalogService, SessionGuard, InfrastructureService, SearchService],
})
export class AppModule {}
