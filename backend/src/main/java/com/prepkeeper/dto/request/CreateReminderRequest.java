package com.prepkeeper.dto.request;

import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.Data;

import java.util.List;

@Data
public class CreateReminderRequest {

    @NotBlank(message = "计划ID不能为空")
    private String planId;

    @NotBlank(message = "调度类型不能为空")
    private String scheduleType;

    /** 关联的任务 ID 列表（可选，为空则针对当天所有未完成任务） */
    @Size(max = 20, message = "最多关联 20 个任务")
    private List<String> taskIds;

    /** INTERVAL 类型的间隔分钟数 */
    private Integer intervalMinutes;

    /** ABSOLUTE / REPEATING 类型的下一次触发时间（ISO 8601 UTC instant，服务端按 timezone 保存本地钟点） */
    private String triggerTime;

    /** 用户时区，如 Asia/Shanghai */
    private String timezone;

    /** REPEATING 类型标记 */
    private Boolean repeatDaily;

    @AssertTrue(message = "INTERVAL 类型必须提供 intervalMinutes")
    public boolean isIntervalValid() {
        if (!"INTERVAL".equals(scheduleType)) return true;
        return intervalMinutes != null && intervalMinutes > 0 && intervalMinutes <= 1440;
    }

    @AssertTrue(message = "ABSOLUTE 或 REPEATING 类型必须提供 triggerTime")
    public boolean isTriggerTimeValid() {
        if ("INTERVAL".equals(scheduleType)) return true;
        return triggerTime != null && !triggerTime.isBlank();
    }
}
