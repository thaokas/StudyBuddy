package com.studybuddy.controller;

import com.studybuddy.dto.request.CheckinRequest;
import com.studybuddy.dto.response.ApiResponse;
import com.studybuddy.dto.response.CheckinResponse;
import com.studybuddy.security.UserPrincipal;
import com.studybuddy.service.CheckinService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@Tag(name = "打卡接口", description = "每日打卡管理")
@RestController
@RequestMapping("/checkins")
@RequiredArgsConstructor
public class CheckinController {

    private final CheckinService checkinService;

    @Operation(summary = "提交打卡")
    @PostMapping
    public ResponseEntity<ApiResponse<CheckinResponse>> checkin(
            @Valid @RequestBody CheckinRequest request,
            @AuthenticationPrincipal UserPrincipal principal) {

        CheckinResponse response = checkinService.checkin(principal.getUserId(), request);
        return ResponseEntity.ok(ApiResponse.success(response));
    }

    @Operation(summary = "获取今日打卡记录")
    @GetMapping("/today")
    public ResponseEntity<ApiResponse<CheckinResponse>> getTodayCheckin(
            @RequestParam String planId,
            @AuthenticationPrincipal UserPrincipal principal) {

        CheckinResponse response = checkinService.getTodayCheckin(principal.getUserId(), planId);
        return ResponseEntity.ok(ApiResponse.success(response));
    }

    @Operation(summary = "获取打卡历史")
    @GetMapping("/history")
    public ResponseEntity<ApiResponse<List<CheckinResponse>>> getCheckinHistory(
            @RequestParam(required = false) LocalDate startDate,
            @RequestParam(required = false) LocalDate endDate,
            @AuthenticationPrincipal UserPrincipal principal) {

        if (startDate == null) {
            startDate = LocalDate.now().minusDays(30);
        }
        if (endDate == null) {
            endDate = LocalDate.now();
        }

        List<CheckinResponse> response = checkinService.getCheckinHistory(principal.getUserId(), startDate, endDate);
        return ResponseEntity.ok(ApiResponse.success(response));
    }

    @Operation(summary = "获取连续打卡天数")
    @GetMapping("/streak")
    public ResponseEntity<ApiResponse<Integer>> getStreak(
            @AuthenticationPrincipal UserPrincipal principal) {

        int streak = checkinService.getCurrentStreak(principal.getUserId());
        return ResponseEntity.ok(ApiResponse.success(streak));
    }

    @Operation(summary = "上传打卡图片")
    @PostMapping("/upload-image")
    public ResponseEntity<ApiResponse<Map<String, String>>> uploadCheckinImage(
            @RequestParam("file") MultipartFile file,
            @AuthenticationPrincipal UserPrincipal principal) throws IOException {

        String uploadDir = "uploads/checkin";
        Path uploadPath = Paths.get(uploadDir);
        if (!Files.exists(uploadPath)) {
            Files.createDirectories(uploadPath);
        }

        String originalName = file.getOriginalFilename();
        String ext = "";
        if (originalName != null && originalName.contains(".")) {
            ext = originalName.substring(originalName.lastIndexOf("."));
        }
        String filename = UUID.randomUUID().toString() + ext;
        Path filePath = uploadPath.resolve(filename);
        file.transferTo(filePath.toFile());

        String imagePath = "/" + uploadDir + "/" + filename;
        return ResponseEntity.ok(ApiResponse.success(Map.of("imageUrl", imagePath)));
    }
}