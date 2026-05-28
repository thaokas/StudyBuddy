package com.prepkeeper.controller;

import com.prepkeeper.dto.request.CreateReminderRequest;
import com.prepkeeper.dto.request.ReminderConfigRequest;
import com.prepkeeper.dto.response.ApiResponse;
import com.prepkeeper.dto.response.PlanResponse;
import com.prepkeeper.dto.response.ReminderSettingsResponse;
import com.prepkeeper.entity.Reminder;
import com.prepkeeper.security.UserPrincipal;
import com.prepkeeper.service.ReminderService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@Tag(name = "提醒接口", description = "提醒设置管理")
@RestController
@RequestMapping("/reminders")
@RequiredArgsConstructor
public class ReminderController {

    private final ReminderService reminderService;

    // ── 原有端点 ──

    @Operation(summary = "获取提醒列表")
    @GetMapping
    public ResponseEntity<ApiResponse<List<Reminder>>> getReminders(
            @AuthenticationPrincipal UserPrincipal principal) {
        List<Reminder> reminders = reminderService.getReminderList(principal.getUserId());
        return ResponseEntity.ok(ApiResponse.success(reminders));
    }

    @Operation(summary = "获取提醒设置")
    @GetMapping("/settings")
    public ResponseEntity<ApiResponse<ReminderSettingsResponse>> getSettings(
            @AuthenticationPrincipal UserPrincipal principal) {
        ReminderSettingsResponse settings = reminderService.getSettings(principal.getUserId());
        return ResponseEntity.ok(ApiResponse.success(settings));
    }

    @Operation(summary = "配置提醒设置")
    @PutMapping("/config")
    public ResponseEntity<ApiResponse<PlanResponse>> configReminder(
            @Valid @RequestBody ReminderConfigRequest request,
            @AuthenticationPrincipal UserPrincipal principal) {
        PlanResponse response = reminderService.configReminder(principal.getUserId(), request);
        return ResponseEntity.ok(ApiResponse.success(response));
    }

    @Operation(summary = "获取提醒历史")
    @GetMapping("/history")
    public ResponseEntity<ApiResponse<List<Reminder>>> getReminderHistory(
            @AuthenticationPrincipal UserPrincipal principal) {
        List<Reminder> history = reminderService.getReminderHistory(principal.getUserId());
        return ResponseEntity.ok(ApiResponse.success(history));
    }

    // ── 新增端点 ──

    @Operation(summary = "创建自定义提醒")
    @PostMapping("/custom")
    public ResponseEntity<ApiResponse<Reminder>> createCustomReminder(
            @Valid @RequestBody CreateReminderRequest request,
            @AuthenticationPrincipal UserPrincipal principal) {
        Reminder reminder = reminderService.createCustomReminder(principal.getUserId(), request);
        return ResponseEntity.ok(ApiResponse.success(reminder));
    }

    @Operation(summary = "取消提醒")
    @DeleteMapping("/{id}")
    public ResponseEntity<ApiResponse<Void>> cancelReminder(
            @PathVariable String id,
            @AuthenticationPrincipal UserPrincipal principal) {
        reminderService.cancelReminder(principal.getUserId(), id);
        return ResponseEntity.ok(ApiResponse.success(null));
    }

    @Operation(summary = "删除提醒历史")
    @DeleteMapping("/history/{id}")
    public ResponseEntity<ApiResponse<Void>> deleteHistoryReminder(
            @PathVariable String id,
            @AuthenticationPrincipal UserPrincipal principal) {
        reminderService.deleteHistoryReminder(principal.getUserId(), id);
        return ResponseEntity.ok(ApiResponse.success(null));
    }

    @Operation(summary = "获取待触发提醒")
    @GetMapping("/pending")
    public ResponseEntity<ApiResponse<List<Reminder>>> getPendingReminders(
            @AuthenticationPrincipal UserPrincipal principal) {
        List<Reminder> pending = reminderService.getPendingReminders(principal.getUserId());
        return ResponseEntity.ok(ApiResponse.success(pending));
    }

    @Operation(summary = "获取未读提醒（已触发但未读）")
    @GetMapping("/unread")
    public ResponseEntity<ApiResponse<List<Reminder>>> getUnreadReminders(
            @AuthenticationPrincipal UserPrincipal principal) {
        List<Reminder> unread = reminderService.getUnreadReminders(principal.getUserId());
        return ResponseEntity.ok(ApiResponse.success(unread));
    }

    @Operation(summary = "标记提醒已读")
    @PutMapping("/{id}/read")
    public ResponseEntity<ApiResponse<Void>> markAsRead(
            @PathVariable String id,
            @AuthenticationPrincipal UserPrincipal principal) {
        reminderService.markAsRead(principal.getUserId(), id);
        return ResponseEntity.ok(ApiResponse.success(null));
    }
}
