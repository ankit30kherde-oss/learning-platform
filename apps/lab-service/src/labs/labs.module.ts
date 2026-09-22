import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { LabsController } from './labs.controller';
import { LabsService } from './labs.service';
import { LabTerminalGateway } from './lab-terminal.gateway';
import { LAB_DRIVER } from './drivers/driver.port';
import { KubernetesDriver } from './drivers/kubernetes.driver';
import { LocalDockerDriver } from './drivers/local-docker.driver';

/**
 * Driver choice is a deployment decision, not a code-path branch scattered
 * through the service: LAB_DRIVER=kubernetes on EKS, anything else falls back
 * to Docker so the lesson still works in Codespaces.
 */
@Module({
  imports: [JwtModule.register({}), ScheduleModule.forRoot()],
  controllers: [LabsController],
  providers: [
    LabsService,
    LabTerminalGateway,
    KubernetesDriver,
    LocalDockerDriver,
    {
      provide: LAB_DRIVER,
      inject: [ConfigService, KubernetesDriver, LocalDockerDriver],
      useFactory: (config: ConfigService, k8sDriver: KubernetesDriver, docker: LocalDockerDriver) =>
        config.get<string>('LAB_DRIVER') === 'kubernetes' ? k8sDriver : docker,
    },
  ],
  exports: [LabTerminalGateway],
})
export class LabsModule {}
