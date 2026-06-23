package com.studybuddy.repository;

import com.studybuddy.entity.Reminder;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.LocalDateTime;
import java.util.List;

@Repository
public interface ReminderRepository extends JpaRepository<Reminder, String> {

    List<Reminder> findByUserId(String userId);

    List<Reminder> findByUserIdOrderByTriggerTimeDesc(String userId);

    List<Reminder> findByUserIdAndIsSent(String userId, Integer isSent);

    /** 查询待触发的提醒 */
    @Query("SELECT r FROM Reminder r WHERE r.status = 'PENDING' AND r.triggerTime <= :now")
    List<Reminder> findPendingReminders(@Param("now") LocalDateTime now);

    /** 查询所有指定状态的提醒 */
    List<Reminder> findByStatus(String status);

    /** 查询用户待触发的提醒 */
    List<Reminder> findByUserIdAndStatus(String userId, String status);

    /** 查询用户已触发且具有可展示内容的提醒历史 */
    @Query("SELECT r FROM Reminder r WHERE r.userId = :userId AND r.status = 'TRIGGERED' " +
            "AND r.content IS NOT NULL AND TRIM(r.content) <> '' ORDER BY r.triggerTime DESC")
    List<Reminder> findTriggeredHistory(@Param("userId") String userId);

    /** 查询用户已触发但未读且具有可展示内容的提醒 */
    @Query("SELECT r FROM Reminder r WHERE r.userId = :userId AND r.status = 'TRIGGERED' AND r.isRead = 0 " +
            "AND r.content IS NOT NULL AND TRIM(r.content) <> '' ORDER BY r.triggerTime DESC")
    List<Reminder> findUnreadReminders(@Param("userId") String userId);

    /** 查询指定状态的提醒（按触发时间） */
    @Query("SELECT r FROM Reminder r WHERE r.status = :status AND r.triggerTime <= :now")
    List<Reminder> findByStatusAndTriggerTimeBefore(@Param("status") String status, @Param("now") LocalDateTime now);

    /** 标记提醒已发送 */
    @Modifying
    @Query("UPDATE Reminder r SET r.isSent = 1, r.sentAt = CURRENT_TIMESTAMP WHERE r.reminderId = :reminderId")
    int markAsSent(@Param("reminderId") String reminderId);

    /** 更新提醒状态 */
    @Modifying
    @Query("UPDATE Reminder r SET r.status = :status, r.updatedAt = CURRENT_TIMESTAMP WHERE r.reminderId = :reminderId")
    int updateStatus(@Param("reminderId") String reminderId, @Param("status") String status);

    /** 原子领取一条待触发提醒，确保业务推送只能由一个消费者执行 */
    @Modifying
    @Query("UPDATE Reminder r SET r.status = 'PROCESSING', r.updatedAt = CURRENT_TIMESTAMP " +
            "WHERE r.reminderId = :reminderId AND r.status = 'PENDING'")
    int claimPending(@Param("reminderId") String reminderId);

    /** 标记一条已触发通知已读 */
    @Modifying
    @Query("UPDATE Reminder r SET r.isRead = 1, r.updatedAt = CURRENT_TIMESTAMP " +
            "WHERE r.reminderId = :reminderId AND r.status = 'TRIGGERED' AND r.isRead = 0")
    int markAsRead(@Param("reminderId") String reminderId);
}
