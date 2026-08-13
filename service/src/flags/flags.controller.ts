import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CreateFlagInput, FlagsService, UpdateFlagInput } from './flags.service';

@Controller()
export class FlagsController {
  constructor(private readonly flags: FlagsService) {}

  @Get('health')
  health() {
    return { status: 'ok', ts: new Date().toISOString() };
  }

  @Get('flags')
  list() {
    return this.flags.listFlags();
  }

  @Get('audit')
  auditAll() {
    return this.flags.getAuditLog();
  }

  @Get('flags/:key')
  get(@Param('key') key: string) {
    return this.flags.getFlag(key);
  }

  @Post('flags')
  create(@Body() body: CreateFlagInput & { actor?: string }) {
    const { actor, ...input } = body ?? ({} as any);
    return this.flags.createFlag(input, actor || 'anonymous');
  }

  @Patch('flags/:key')
  update(@Param('key') key: string, @Body() body: UpdateFlagInput & { actor?: string }) {
    const { actor, ...patch } = body ?? ({} as any);
    return this.flags.updateFlag(key, patch, actor || 'anonymous');
  }

  @Get('flags/:key/evaluate')
  evaluate(@Param('key') key: string, @Query('userId') userId: string, @Query('default') def?: string) {
    if (!userId) throw new BadRequestException('userId query param is required');
    return this.flags.evaluate(key, userId, def === 'true');
  }

  @Get('flags/:key/audit')
  auditForFlag(@Param('key') key: string) {
    return this.flags.getAuditLog(key);
  }

  @Post('flags/:key/rollback/:auditId')
  rollback(@Param('key') key: string, @Param('auditId') auditId: string, @Body() body: { actor?: string }) {
    return this.flags.rollback(key, auditId, body?.actor || 'anonymous');
  }
}
