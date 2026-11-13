import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { MonitoringController } from './controllers/monitoring.controller';
import { MonitoringService } from './models/monitoring.service';
import { ExpiryMonitorService } from './models/expiry-monitor.service';
import { NetworkMonitorService } from './models/network-monitor.service';
import { NetworkProbe } from './models/network-probe';
import { MonitoringTargetsService } from './models/monitoring-targets.service';
import { MonitoringTargetsController } from './controllers/monitoring-targets.controller';
import { AlertsController, NotificationsController } from './controllers/notifications.controller';
import { NotificationsService } from './models/notifications.service';
import { AttachmentsController, PermissionsController } from './controllers/attachments.controller';
import { AuditController } from './controllers/audit.controller';
import { AuthController } from './controllers/auth.controller';
import { ApplicationDatabasesController, catalogControllers } from './controllers/catalog.controller';
import { ReportsController } from './controllers/reports.controller';
import { HealthController } from './controllers/health.controller';
import { infrastructureControllers } from './controllers/infrastructure.controller';
import { SearchController } from './controllers/search.controller';
import { UsersController } from './controllers/users.controller';
import { SessionGuard } from './guards/session.guard';
import { AttachmentsService } from './models/attachments.service';
import { AuditService } from './models/audit.service';
import { FileStore } from './models/file-store';
import { PermissionsService } from './models/permissions.service';
import { AuthService } from './models/auth.service';
import { CatalogService } from './models/catalog.service';
import { Database } from './models/database';
import { InfrastructureService } from './models/infrastructure.service';
import { ReportsService } from './models/reports.service';
import { SearchService } from './models/search.service';
import { UsersService } from './models/users.service';
import { ImportsController } from './controllers/imports.controller';
import { ImportsService } from './models/imports.service';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [HealthController, AuthController, UsersController, AuditController, ...catalogControllers, ApplicationDatabasesController,
    ...infrastructureControllers, SearchController, AttachmentsController, PermissionsController, ImportsController, MonitoringController, MonitoringTargetsController,
    AlertsController, NotificationsController, ReportsController],
  providers: [Database, AuditService, AuthService, UsersService, CatalogService, SessionGuard, InfrastructureService, SearchService,
    FileStore, PermissionsService, AttachmentsService, ImportsService, MonitoringService, ExpiryMonitorService,
    NetworkProbe, NetworkMonitorService, MonitoringTargetsService, NotificationsService, ReportsService],
})
export class AppModule {}
