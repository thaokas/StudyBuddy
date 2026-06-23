package com.studybuddy.controller;

import com.studybuddy.dto.request.LoginRequest;
import com.studybuddy.dto.request.RefreshTokenRequest;
import com.studybuddy.dto.request.RegisterRequest;
import com.studybuddy.dto.response.ApiResponse;
import com.studybuddy.dto.response.AuthResponse;
import com.studybuddy.dto.response.UserResponse;
import com.studybuddy.security.UserPrincipal;
import com.studybuddy.service.AuthService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

@Tag(name = "认证接口", description = "用户注册、登录、Token刷新")
@RestController
@RequestMapping("/auth")
@RequiredArgsConstructor
public class AuthController {

    private final AuthService authService;

    @Operation(summary = "用户注册")
    @PostMapping("/register")
    public ResponseEntity<ApiResponse<AuthResponse>> register(@Valid @RequestBody RegisterRequest request) {
        AuthResponse response = authService.register(request);
        return ResponseEntity.ok(ApiResponse.success(response));
    }

    @Operation(summary = "用户登录")
    @PostMapping("/login")
    public ResponseEntity<ApiResponse<AuthResponse>> login(@Valid @RequestBody LoginRequest request) {
        AuthResponse response = authService.login(request);
        return ResponseEntity.ok(ApiResponse.success(response));
    }

    @Operation(summary = "刷新Token")
    @PostMapping("/refresh")
    public ResponseEntity<ApiResponse<AuthResponse>> refresh(@Valid @RequestBody RefreshTokenRequest request) {
        String refreshToken = request.getRefreshToken();
        AuthResponse response = authService.refreshToken(refreshToken);
        return ResponseEntity.ok(ApiResponse.success(response));
    }

    @Operation(summary = "获取当前用户信息")
    @GetMapping("/me")
    public ResponseEntity<ApiResponse<UserResponse>> getCurrentUser(@AuthenticationPrincipal UserPrincipal principal) {
        // 通过UserService获取完整用户信息
        return ResponseEntity.ok(ApiResponse.success(
                UserResponse.builder()
                        .userId(principal.getUserId())
                        .email(principal.getEmail())
                        .nickname(principal.getNickname())
                        .build()
        ));
    }
}