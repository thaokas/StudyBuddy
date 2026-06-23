package com.studybuddy.dto.response;

import lombok.Builder;
import lombok.Data;
import java.util.List;

@Data
@Builder
public class ReminderSettingsResponse {

    private Integer mode;
    private List<String> customTimes;
    private Integer monkingInterval;
    private Integer hellInterval;
    private Boolean isActive;
}
